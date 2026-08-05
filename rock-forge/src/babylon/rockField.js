// The field: every rock in the world, in one thin-instance buffer per
// (archetype, LOD) pair.
//
// The base meshes are literally the same unit sphere at three subdivisions,
// with `position` holding the vertex direction and `vertIndex` holding its
// index into the shape texture. Nothing here knows what a rock looks like.
//
// LOD works because of the icosphere's prefix property: level 1's vertices are
// the first 42 of level 3's, so all three LODs read the same rows of the same
// texture and a rock keeps its exact shape and normals as it switches. That is
// what stops LOD transitions popping — the usual cause is independently
// simplified meshes disagreeing about where the surface is, and here they
// cannot disagree.

import { Matrix, Mesh, Quaternion, VertexData, Vector3 } from "@babylonjs/core";

/** Distance at which a rock drops a LOD, as a multiple of its own size. */
const DEFAULT_LOD_STEPS = [16, 48];

/** Debug tints: LOD0 green, LOD1 amber, LOD2 red. */
const LOD_COLOURS = [[0.25, 0.85, 0.35], [0.95, 0.7, 0.15], [0.9, 0.25, 0.2]];

/**
 * @param {Float32Array} dirs the archetype's own direction set. It must be the
 *   one its shapes were baked against — the shape texture stores a radius per
 *   *vertex index*, so a mesh using different directions would put every radius
 *   in the wrong place.
 */
function createBaseMesh(scene, dirs, lvl, name) {
  const n = lvl.vertexCount;

  const positions = new Float32Array(n * 3);
  positions.set(dirs.subarray(0, n * 3));

  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  // Placeholder: the vertex shader overwrites this from the shape texture. It
  // has to exist, because its presence is what sets Babylon's NORMAL define and
  // therefore whether vNormalW is computed at all.
  vd.normals = Float32Array.from(positions);
  vd.indices = Array.from(lvl.indices);
  vd.applyToMesh(mesh, false);

  const ids = new Float32Array(n);
  for (let i = 0; i < n; i++) ids[i] = i;
  mesh.setVerticesData("vertIndex", ids, false, 1);

  // Thin-instance bounds are the base mesh's bounds scaled by each matrix. The
  // base is a unit sphere and a baked shape never exceeds radius ~0.7, so this
  // over-estimates — which is the safe direction. Syncing it per update would
  // cost more than it saves.
  mesh.doNotSyncBoundingInfo = true;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  return mesh;
}

class Bucket {
  constructor(mesh) {
    this.mesh = mesh;
    this.capacity = 0;
    this.matrices = null;
    this.insts = null;
    this.vars = null;
    this.count = 0;
  }

  reserve(n) {
    if (n <= this.capacity) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    this.matrices = new Float32Array(cap * 16);
    this.insts = new Float32Array(cap * 4);
    this.vars = new Float32Array(cap * 2);
    this.capacity = cap;
    // staticBuffer=false: these are rewritten whenever the camera moves enough.
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("rockInst", this.insts, 4, false);
    this.mesh.thinInstanceSetBuffer("rockVar", this.vars, 2, false);
  }

  flush() {
    this.mesh.thinInstanceCount = this.count;
    this.mesh.setEnabled(this.count > 0);
    if (this.count > 0) {
      // Partial uploads, not thinInstanceBufferUpdated: that call re-sends the
      // ENTIRE capacity-sized buffer, and capacity is the power-of-two above
      // the archetype's whole population — so every rebucket (every couple of
      // centimetres of camera travel) was pushing the full field's worth of
      // matrices to the GPU even when one LOD bucket held a dozen stones. The
      // numeric form uploads exactly `count` instances' worth as a zero-copy
      // view over the same arrays update() just wrote. At 40k rocks this is
      // the difference between ~10 MB and ~3 MB per orbit step, and the win
      // grows as LOD splits the field unevenly.
      this.mesh.thinInstancePartialBufferUpdate("matrix", this.count, 0);
      this.mesh.thinInstancePartialBufferUpdate("rockInst", this.count, 0);
      this.mesh.thinInstancePartialBufferUpdate("rockVar", this.count, 0);
    }
  }
}

export class RockField {
  /**
   * @param {object} opts
   * @param {number[]} opts.lodLevels icosphere levels, finest first
   * @param {number[]} opts.lodSteps  switch distances as multiples of rock size
   */
  constructor(scene, lib, materials, { lodLevels = [3, 2, 1], lodSteps = DEFAULT_LOD_STEPS } = {}) {
    this.scene = scene;
    this.lib = lib;
    this.lodLevels = lodLevels;
    this.lodSteps = lodSteps.slice();
    this.forcedLod = -1;      // -1 = automatic
    this.lodDebug = false;    // replace per-instance tint with a LOD colour
    this.groups = new Map();  // archetype -> { buckets, master }
    this.materials = materials;
    this._lastCam = new Vector3(1e9, 1e9, 1e9);
    this.rebuilds = 0;
    this.lastRebucketMs = 0;

    for (const [name, mat] of Object.entries(materials)) {
      const dirs = lib.dirsByArchetype[name];
      const buckets = lodLevels.map((level, i) =>
        new Bucket(createBaseMesh(scene, dirs, lib.ico.levels[level], `rock_${name}_lod${i}`)));
      for (const b of buckets) b.mesh.material = mat;
      this.groups.set(name, { buckets, master: null });
    }
  }

  /**
   * @param {Array<{shape:number, position:Vector3|number[], rotation:Quaternion|number[], size:number, tint:number[]}>} instances
   */
  setInstances(instances) {
    const byArch = new Map();
    for (const inst of instances) {
      const arch = this.lib.shapes[inst.shape].archetype;
      let list = byArch.get(arch);
      if (!list) byArch.set(arch, (list = []));
      list.push(inst);
    }

    const m = new Matrix();
    const scale = new Vector3();
    const pos = new Vector3();
    const rot = new Quaternion();

    for (const [name, group] of this.groups) {
      const list = byArch.get(name) || [];
      const n = list.length;
      const master = {
        count: n,
        matrices: new Float32Array(n * 16),
        insts: new Float32Array(n * 4),
        vars: new Float32Array(n * 2),
        sizes: new Float32Array(n),
        centres: new Float32Array(n * 3),
        lod: new Uint8Array(n),
      };

      for (let i = 0; i < n; i++) {
        const inst = list[i];
        const p = inst.position;
        const q = inst.rotation;
        pos.set(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]);
        rot.set(q.x ?? q[0], q.y ?? q[1], q.z ?? q[2], q.w ?? q[3]);
        scale.set(inst.size, inst.size, inst.size);
        Matrix.ComposeToRef(scale, rot, pos, m);
        m.copyToArray(master.matrices, i * 16);

        master.insts[i * 4] = inst.shape;
        master.insts[i * 4 + 1] = inst.tint[0];
        master.insts[i * 4 + 2] = inst.tint[1];
        master.insts[i * 4 + 3] = inst.tint[2];
        // Offset into the shared variation map. Derived from the shape index
        // and the instance's own slot, so it is stable if the rock moves —
        // markings that swim when a stone is picked up would be worse than
        // no markings at all.
        master.vars[i * 2] = ((inst.shape * 37 + i * 17) % 101) / 101;
        master.vars[i * 2 + 1] = ((inst.shape * 53 + i * 29) % 97) / 97;
        master.sizes[i] = inst.size;
        master.centres[i * 3] = pos.x;
        master.centres[i * 3 + 1] = pos.y;
        master.centres[i * 3 + 2] = pos.z;
      }

      group.master = master;
      for (const b of group.buckets) b.reserve(n);
    }

    this._lastCam.set(1e9, 1e9, 1e9); // force a rebucket
  }

  /** Re-sort instances into LOD buckets. Cheap enough to call every frame, but
   *  it only does work when the camera has actually moved. */
  update(cameraPosition, force = false) {
    // AUDIT #B6: 20 cm of travel (was 2 cm) before a rebucket — the old
    // threshold fired every frame of an orbit, an O(N) pass plus up to 63
    // partial buffer uploads. LOD bands are metres wide; 20 cm cannot skip one.
    if (!force && Vector3.DistanceSquared(cameraPosition, this._lastCam) < 0.04) return;
    this._lastCam.copyFrom(cameraPosition);
    this.rebuilds++;

    const t0 = performance.now();
    const cx = cameraPosition.x, cy = cameraPosition.y, cz = cameraPosition.z;
    const nLod = this.lodLevels.length;
    const forced = this.forcedLod;

    for (const group of this.groups.values()) {
      const M = group.master;
      if (!M) continue;
      for (const b of group.buckets) b.count = 0;

      for (let i = 0; i < M.count; i++) {
        let lod;
        if (forced >= 0) {
          lod = Math.min(forced, nLod - 1);
        } else {
          const dx = M.centres[i * 3] - cx;
          const dy = M.centres[i * 3 + 1] - cy;
          const dz = M.centres[i * 3 + 2] - cz;
          // Compare squared distance against squared thresholds: no sqrt in the
          // inner loop, which is the whole cost of this function at 20k rocks.
          const d2 = dx * dx + dy * dy + dz * dz;
          const s = M.sizes[i];
          lod = 0;
          for (let l = 0; l < nLod - 1; l++) {
            const t = this.lodSteps[l] * s;
            if (d2 > t * t) lod = l + 1; else break;
          }
        }
        M.lod[i] = lod;

        const b = group.buckets[lod];
        const o = b.count * 16;
        const src = i * 16;
        // AUDIT #B6: block copy — the scalar 16-iteration loop was 44k float
        // writes per rebucket at 2k rocks, 1.4M at the bench top step.
        b.matrices.set(M.matrices.subarray(src, src + 16), o);
        const oi = b.count * 4, si = i * 4;
        b.insts[oi] = M.insts[si];
        if (this.lodDebug) {
          const c = LOD_COLOURS[lod % LOD_COLOURS.length];
          b.insts[oi + 1] = c[0]; b.insts[oi + 2] = c[1]; b.insts[oi + 3] = c[2];
        } else {
          b.insts[oi + 1] = M.insts[si + 1];
          b.insts[oi + 2] = M.insts[si + 2];
          b.insts[oi + 3] = M.insts[si + 3];
        }
        b.vars[b.count * 2] = M.vars[i * 2];
        b.vars[b.count * 2 + 1] = M.vars[i * 2 + 1];
        b.count++;
      }

      for (const b of group.buckets) b.flush();
    }
    this.lastRebucketMs = performance.now() - t0;
  }

  stats() {
    const perLod = this.lodLevels.map(() => 0);
    let triangles = 0, draws = 0, total = 0;
    for (const group of this.groups.values()) {
      group.buckets.forEach((b, i) => {
        perLod[i] += b.count;
        total += b.count;
        if (b.count > 0) {
          draws++;
          triangles += b.count * (this.lib.ico.levels[this.lodLevels[i]].indices.length / 3);
        }
      });
    }
    return { perLod, triangles, draws, total, rebucketMs: this.lastRebucketMs };
  }

  dispose() {
    for (const group of this.groups.values()) for (const b of group.buckets) b.mesh.dispose();
    this.groups.clear();
  }
}
