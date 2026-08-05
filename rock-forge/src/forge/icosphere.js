// The one piece of topology the whole field shares.
//
// A subdivided icosahedron, built so that the vertices of level N are a strict
// *prefix* of the vertices of level N+1: midpoint subdivision only ever appends.
// That property is what makes the whole scheme work. Every LOD can index into
// the same per-vertex shape data, so a rock needs exactly one row in the shape
// texture no matter how many detail levels it is drawn at, and a vertex keeps
// its identity as it moves between LODs (no popping from re-derived normals).
//
// Vertex counts / triangle counts by level:
//   0:   12 v /    20 t      3:  642 v /  1280 t
//   1:   42 v /    80 t      4: 2562 v /  5120 t
//   2:  162 v /   320 t      5: 10242 v / 20480 t

const T = (1 + Math.sqrt(5)) / 2;

const BASE_VERTS = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];

const BASE_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

const cache = new Map();

/**
 * @param {number} maxLevel highest subdivision level to build
 * @param {number[]|null} warp per-axis scale applied to each direction before
 *   renormalising. This is how a flat stone gets a tessellation that can
 *   actually describe it.
 *
 *   An icosphere spreads vertices evenly over the sphere, but a rock's radius
 *   does not vary evenly. On a 7 cm slate disc it falls 38 mm to 32 mm within
 *   six degrees of the equator, while the icosphere's "equator" vertices are
 *   scattered across latitudes 0.000 to 0.082. Adjacent rim vertices therefore
 *   land at meaningfully different latitudes and get meaningfully different
 *   radii — measured, 80% of them more than a millimetre apart, the worst 12 mm.
 *   That alternation is a sawtooth rim, and it is a sampling artefact, not a
 *   shape: the analytic surface underneath is smooth.
 *
 *   Scaling directions by the stone's own axis ratios crowds them toward the
 *   rim in proportion to how flat it is. Measured over six archetypes, an
 *   exponent of 1.25 on those ratios is the sweet spot: it takes slate from
 *   75% of rim vertices deviating to 8%, and the worst deviation from 9.5 mm to
 *   2.9 mm. Higher exponents start starving the flat faces and get worse again.
 *
 * @returns {{ dirs: Float32Array, levels: Array<{ level:number, vertexCount:number, indices:Uint32Array }> }}
 *   `dirs` is xyz unit directions for the *finest* level; every coarser level
 *   uses the same array truncated to its own vertexCount.
 */
export function buildIcosphere(maxLevel, warp = null) {
  const key = `${maxLevel}|${warp ? warp.join(",") : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = buildIcosphereUncached(maxLevel, warp);
  cache.set(key, built);
  return built;
}

function buildIcosphereUncached(maxLevel, warp) {
  // A warp only moves vertices — subdivision is pure index bookkeeping, so the
  // topology (and the prefix property) is byte-identical for every warp of the
  // same level. Build the unwarped base once through the cache and share its
  // `levels` arrays outright; only the direction array is per-warp. With one
  // warped variant per archetype this stops fifteen copies of the same index
  // buffers being built and held, and it makes bake stats' indexBytes honest —
  // it was counting one copy while the old code allocated one per archetype.
  if (warp) {
    const base = buildIcosphere(maxLevel);
    const dirs = new Float32Array(base.dirs.length);
    for (let i = 0; i < base.dirs.length; i += 3) {
      const x = base.dirs[i] * warp[0];
      const y = base.dirs[i + 1] * warp[1];
      const z = base.dirs[i + 2] * warp[2];
      const l = Math.hypot(x, y, z) || 1;
      dirs[i] = x / l; dirs[i + 1] = y / l; dirs[i + 2] = z / l;
    }
    return { dirs, levels: base.levels };
  }

  const xs = [], ys = [], zs = [];
  const push = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    xs.push(x / l); ys.push(y / l); zs.push(z / l);
    return xs.length - 1;
  };
  for (const v of BASE_VERTS) push(v[0], v[1], v[2]);

  let faces = BASE_FACES.map((f) => f.slice());
  const levels = [{ level: 0, vertexCount: xs.length, indices: flatten(faces) }];

  // Midpoints are cached per edge so the two triangles sharing it agree on the
  // vertex — otherwise the mesh cracks and normals go wrong along every seam.
  for (let l = 1; l <= maxLevel; l++) {
    const cache = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = push((xs[a] + xs[b]) / 2, (ys[a] + ys[b]) / 2, (zs[a] + zs[b]) / 2);
        cache.set(key, m);
      }
      return m;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
    levels.push({ level: l, vertexCount: xs.length, indices: flatten(faces) });
  }

  const dirs = new Float32Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) {
    dirs[i * 3] = xs[i]; dirs[i * 3 + 1] = ys[i]; dirs[i * 3 + 2] = zs[i];
  }
  return { dirs, levels };
}

/**
 * Flatten to an index buffer, reversing each triangle's winding.
 *
 * The classic icosahedron face table above is wound the opposite way round from
 * Babylon's own primitives — a MeshBuilder sphere has *negative* signed volume,
 * this table gives positive. Left uncorrected, every rock renders as a hollow
 * shell: the front faces are culled and you see the inside of the far wall,
 * which reads as a crescent. tools/winding-check.mjs measures both against a
 * MeshBuilder sphere, which is the one reference that cannot itself be wrong.
 */
function flatten(faces) {
  const out = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    out[i * 3] = faces[i][0]; out[i * 3 + 1] = faces[i][2]; out[i * 3 + 2] = faces[i][1];
  }
  return out;
}

/**
 * Area-weighted vertex normals for a radially displaced sphere.
 *
 * Radii are per-vertex; positions are dir * radius. Weighting by the cross
 * product's own magnitude (rather than normalising per face) means a large
 * facet outvotes the sliver triangles along its rounded edge, which is what
 * keeps flat faces reading as flat.
 */
export function computeRadialNormals(dirs, radii, indices, vertexCount, out) {
  const n = out || new Float32Array(vertexCount * 3);
  n.fill(0, 0, vertexCount * 3);

  for (let f = 0; f < indices.length; f += 3) {
    const ia = indices[f], ib = indices[f + 1], ic = indices[f + 2];
    const ax = dirs[ia * 3] * radii[ia], ay = dirs[ia * 3 + 1] * radii[ia], az = dirs[ia * 3 + 2] * radii[ia];
    const bx = dirs[ib * 3] * radii[ib], by = dirs[ib * 3 + 1] * radii[ib], bz = dirs[ib * 3 + 2] * radii[ib];
    const cx = dirs[ic * 3] * radii[ic], cy = dirs[ic * 3 + 1] * radii[ic], cz = dirs[ic * 3 + 2] * radii[ic];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    n[ia * 3] += nx; n[ia * 3 + 1] += ny; n[ia * 3 + 2] += nz;
    n[ib * 3] += nx; n[ib * 3 + 1] += ny; n[ib * 3 + 2] += nz;
    n[ic * 3] += nx; n[ic * 3 + 1] += ny; n[ic * 3 + 2] += nz;
  }

  for (let i = 0; i < vertexCount; i++) {
    let x = n[i * 3], y = n[i * 3 + 1], z = n[i * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    // Orient outward from the vertex direction rather than from the winding.
    // On a star-shaped surface the outward normal always has a positive
    // component along its own direction, so this is exact — and it means the
    // shading cannot silently disagree with the winding if the index order is
    // ever changed again.
    if (x * dirs[i * 3] + y * dirs[i * 3 + 1] + z * dirs[i * 3 + 2] < 0) {
      x = -x; y = -y; z = -z;
    }
    n[i * 3] = x; n[i * 3 + 1] = y; n[i * 3 + 2] = z;
  }
  return n;
}
