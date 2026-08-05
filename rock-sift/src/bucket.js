// A bucket beside each sifting spot, to drop the stones you want to keep into.
//
// The model arrives off-centre and at an arbitrary scale, so it is recentred on
// its own axis, stood on y = 0 and scaled to a real bucket's height once at load.
// After that it is instanced per spot like everything else.
//
// Collision is NOT the bucket mesh. A convex hull of a bucket is a solid lump
// with no inside, and a triangle mesh of one — which is what this used to use —
// gives the stones an inside they can never rest in: a convex hull sitting
// across a grid of triangles catches on the internal edges between them and gets
// kicked, so the contents fidget forever. The ground had exactly this problem and
// was fixed the same way — see buildGroundCollider in environment.js.
//
// So the collider is built from primitives instead: a cylinder for the floor and
// stacked rings of boxes for the wall. A cylinder has a single flat top face with
// no internal edges at all, which is what lets a stone actually settle on it.
//
// The wall has to FOLLOW THE TAPER. This model is a cone — much wider at the rim
// than at the base — and a single ring sized from the rim sits well outside the
// wall lower down, so stones settle against a collider that is not where the
// bucket is and visibly poke out through the side. The interior radius is
// measured at a series of heights and the ring is rebuilt at each.
//
// Every band is pulled slightly INSIDE the measured surface. Erring inward hides
// the staircase between bands inside the mesh; erring outward would put it back
// on display as stones clipping through.

import {
  ImportMeshAsync, Matrix, Mesh, PhysicsBody, PhysicsMotionType, PhysicsShapeBox,
  PhysicsShapeContainer, PhysicsShapeCylinder, Quaternion, Vector3, VertexBuffer,
} from "@babylonjs/core";

// Stones run 3.5 to 8.5 cm, so this cannot go much below 14 cm and still take
// the big ones: at 14 cm tall this model's mouth is about 17 cm across, which
// clears the largest stone with room to spare. Ten times smaller as asked would
// be a 3 cm bucket, which the stones would not fit in at all.
const HEIGHT_METRES = 0.14;
const RIM_CLEARANCE = 0.06;   // metres a carried stone rides above the rim
const WALL_SEGMENTS = 16;     // boxes around each ring
const WALL_BANDS = 12;        // rings stacked up the taper
const INSET = 0.97;           // keep the collider just inside the visible wall
const HEAP_ROOM = 0.05;       // metres a stone may sit proud of the rim and still count

/**
 * @returns { place(origin), contains(point), clearanceAt(x, z), rimY, radius }
 *          or null if the model could not be loaded
 */
export async function loadBucket(scene, url, { unitScale: U }) {
  const result = await ImportMeshAsync(url, scene);
  const parts = result.meshes.filter((m) => m.getTotalVertices?.() > 0);
  if (!parts.length) return null;

  // --- measure it where it stands ------------------------------------------
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of parts) {
    const b = m.getBoundingInfo().boundingBox;
    const lo = [b.minimumWorld.x, b.minimumWorld.y, b.minimumWorld.z];
    const hi = [b.maximumWorld.x, b.maximumWorld.y, b.maximumWorld.z];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], lo[k]);
      max[k] = Math.max(max[k], hi[k]);
    }
  }
  const scale = (HEIGHT_METRES * U) / (max[1] - min[1]);
  const centre = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];

  // --- bake that into the geometry, once ------------------------------------
  // Baked rather than left on a parent transform: a physics shape built from a
  // scaled node does not reliably inherit that scale, and a bucket whose
  // collision is a different size from its picture is a bad afternoon.
  const fix = Matrix.Translation(-centre[0], -centre[1], -centre[2])
    .multiply(Matrix.Scaling(scale, scale, scale));

  for (const m of parts) {
    m.setParent(null);
    m.bakeTransformIntoVertices(m.getWorldMatrix().multiply(fix));
    m.position.setAll(0);
    m.rotationQuaternion = Quaternion.Identity();
    m.scaling.setAll(1);
    m.isPickable = false;
    m.receiveShadows = true;
  }
  for (const n of result.transformNodes ?? []) n.dispose();

  // --- the interior profile -------------------------------------------------
  // How wide the inside is at each height. At any height above the base the
  // narrowest geometry is the inner wall — the outer shell and the handle are
  // both further out — so a low percentile of the radii in a band finds it.
  const rimY = (max[1] - min[1]) * scale;
  const bands = Array.from({ length: WALL_BANDS }, () => []);
  const bandHeight = rimY / WALL_BANDS;

  for (const m of parts) {
    const p = m.getVerticesData(VertexBuffer.PositionKind);
    for (let i = 0; i < p.length; i += 3) {
      const k = Math.floor(p[i + 1] / bandHeight);
      if (k < 0 || k >= WALL_BANDS) continue;
      bands[k].push(Math.hypot(p[i], p[i + 2]));
    }
  }

  const profile = bands.map((rs) => {
    if (!rs.length) return 0;
    rs.sort((a, b) => a - b);
    return rs[Math.floor(rs.length * 0.08)] * INSET;
  });
  // A band with no geometry, or the base disc dragging a band's percentile down
  // to nothing, inherits from the band above rather than pinching the wall shut.
  for (let k = WALL_BANDS - 2; k >= 0; k--) {
    if (profile[k] < profile[k + 1] * 0.25) profile[k] = profile[k + 1] * 0.5;
  }

  const radius = profile[WALL_BANDS - 1];  // at the mouth, for approach and reach
  const floorY = 0;                        // the base of a cone bottoms out at its stand

  // Out of sight, but NOT disabled: an instance is only drawn if its source mesh
  // is enabled, so disabling these would make every bucket vanish.
  for (const m of parts) m.position.set(0, -50 * U, 0);

  console.log(`bucket: ${(rimY / U * 100).toFixed(1)} cm tall, mouth ` +
    `${(radius / U * 200).toFixed(1)} cm across, base ${(profile[0] / U * 200).toFixed(1)} cm`);

  // --- collider, from primitives -------------------------------------------
  const wallThickness = 0.01 * U;
  const surface = { friction: 0.7, restitution: 0.02 };

  // One body per bucket rather than one per box: a container holds the whole
  // assembly as a single compound shape.
  const shape = new PhysicsShapeContainer(scene);

  const floorShape = new PhysicsShapeCylinder(
    new Vector3(0, -wallThickness, 0), new Vector3(0, 0, 0), profile[0], scene
  );
  floorShape.material = surface;
  shape.addChild(floorShape);

  for (let k = 0; k < WALL_BANDS; k++) {
    const r = profile[k];
    const y = (k + 0.5) * bandHeight;
    // Overlapping in both directions, so the staircase has no gap a small stone
    // could squeeze through — vertically between bands, and around each ring.
    const chord = 2 * r * Math.tan(Math.PI / WALL_SEGMENTS) * 1.35;
    for (let i = 0; i < WALL_SEGMENTS; i++) {
      const a = (i / WALL_SEGMENTS) * Math.PI * 2;
      const wall = new PhysicsShapeBox(
        new Vector3(Math.cos(a) * (r + wallThickness / 2), y, Math.sin(a) * (r + wallThickness / 2)),
        // Yaw of -a puts the box's local X on the radius: rotating (1,0,0) about
        // Y by t gives (cos t, 0, -sin t), and we want (cos a, 0, sin a).
        Quaternion.RotationYawPitchRoll(-a, 0, 0),
        new Vector3(wallThickness, bandHeight * 1.2, chord),
        scene
      );
      wall.material = surface;
      shape.addChild(wall);
    }
  }

  const placed = [];

  return {
    rimY,
    radius,
    parts,

    /** One bucket, stood on the sand at `origin`. */
    place(origin) {
      parts.forEach((m, i) => {
        const inst = m.createInstance(`bucketPart_${placed.length}_${i}`);
        inst.position.copyFrom(origin);
        inst.isPickable = false;
        inst.receiveShadows = true;
        inst.freezeWorldMatrix();
      });

      const node = new Mesh(`bucketBody_${placed.length}`, scene);
      node.position.copyFrom(origin);
      const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
      body.shape = shape;

      const entry = { origin: origin.clone() };
      placed.push(entry);
      return entry;
    },

    /**
     * How wide the inside is at height `y`, following the taper. Above the rim
     * it stays at the mouth width rather than running off the end of the
     * profile, so a stone heaped proud of the rim still measures as inside.
     */
    radiusAt(y) {
      const t = Math.min(WALL_BANDS - 1, Math.max(0, y / bandHeight - 0.5));
      const k = Math.floor(t);
      const f = t - k;
      return profile[k] + (profile[Math.min(WALL_BANDS - 1, k + 1)] - profile[k]) * f;
    },

    /** Is this world point inside a bucket? */
    contains(point) {
      for (const b of placed) {
        const y = point.y - b.origin.y;
        // HEAP_ROOM above the rim, because stones stack. This bucket is a cone
        // that is only 3.8 cm across at the base, so a handful of 5 cm stones
        // wedge partway up it and the last one sits proud of the mouth — plainly
        // in the bucket, and cut off by a strict rim test.
        if (y < -0.02 * U || y > rimY + HEAP_ROOM * U) continue;
        // Against the profile rather than one radius: a cone measured by its
        // mouth also swallows stones lying on the sand beside its base.
        if (Math.hypot(point.x - b.origin.x, point.z - b.origin.z) < this.radiusAt(y)) return true;
      }
      return false;
    },

    /** How many of `rocks` are sitting in a bucket. */
    count(rocks) {
      let n = 0;
      for (const r of rocks) if (this.contains(r.node.position)) n++;
      return n;
    },

    /**
     * How high a carried stone has to ride at this point on the ground.
     *
     * Without this a stone carried at its usual 13 cm collides with the outside
     * of the bucket instead of going in. Approaching one it lifts to clear the
     * rim — which is also just what you would do.
     */
    clearanceAt(x, z) {
      let highest = 0;
      for (const b of placed) {
        const d = Math.hypot(x - b.origin.x, z - b.origin.z);
        if (d < radius * 2.1) highest = Math.max(highest, rimY + RIM_CLEARANCE * U);
      }
      return highest;
    },
  };
}
