// Incremental 3D convex hull. Test-only: it exists so collision-test.mjs can
// measure the physics shape exactly instead of approximating it.
//
// The first version of that test approximated the hull as the intersection of
// half-spaces sampled over an icosphere, and got the flat stones wrong by 15%
// in the same direction and for the same reason the hull sampling itself got
// them wrong — an isotropic direction set under-resolves a rim. A measuring
// instrument with the bug it is measuring is worse than no measurement, so this
// computes the real thing.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * @param {Float32Array|number[]} xyz flat xyz point list
 * @returns {{ faces: Array<{v:number[], n:number[], off:number}>, points: number[][] }}
 *   `off` is the plane offset: the face lies on dot(n, x) = off, n pointing out.
 */
export function convexHull(xyz) {
  const P = [];
  for (let i = 0; i < xyz.length; i += 3) P.push([xyz[i], xyz[i + 1], xyz[i + 2]]);
  if (P.length < 4) throw new Error("convexHull needs at least 4 points");

  let scale = 0;
  for (const p of P) scale = Math.max(scale, norm(p));
  const eps = scale * 1e-7;

  // --- seed tetrahedron ---------------------------------------------------
  let i0 = 0;
  for (let i = 1; i < P.length; i++) if (P[i][0] < P[i0][0]) i0 = i;

  let i1 = -1, best = eps;
  for (let i = 0; i < P.length; i++) {
    const d = norm(sub(P[i], P[i0]));
    if (d > best) { best = d; i1 = i; }
  }
  if (i1 < 0) throw new Error("degenerate point set (all coincident)");

  let i2 = -1; best = eps;
  const e01 = sub(P[i1], P[i0]);
  for (let i = 0; i < P.length; i++) {
    const a = norm(cross(e01, sub(P[i], P[i0]))) / norm(e01);
    if (a > best) { best = a; i2 = i; }
  }
  if (i2 < 0) throw new Error("degenerate point set (collinear)");

  let i3 = -1; best = eps;
  const nSeed = cross(e01, sub(P[i2], P[i0]));
  const nSeedLen = norm(nSeed);
  for (let i = 0; i < P.length; i++) {
    const d = Math.abs(dot(nSeed, sub(P[i], P[i0]))) / nSeedLen;
    if (d > best) { best = d; i3 = i; }
  }
  if (i3 < 0) throw new Error("degenerate point set (coplanar)");

  // Any point strictly inside the hull works as the orientation reference, and
  // the seed tetrahedron's centroid is inside it for the whole construction.
  const interior = [0, 1, 2].map((c) => (P[i0][c] + P[i1][c] + P[i2][c] + P[i3][c]) / 4);

  const makeFace = (a, b, c) => {
    let n = cross(sub(P[b], P[a]), sub(P[c], P[a]));
    const l = norm(n);
    if (l < 1e-20) return null;
    n = [n[0] / l, n[1] / l, n[2] / l];
    let off = dot(n, P[a]);
    // Orient outward by testing the known-interior point rather than by
    // tracking edge winding. Slower, and immune to the winding bugs that make
    // incremental hulls fail on one input in fifty.
    if (dot(n, interior) > off) { n = [-n[0], -n[1], -n[2]]; off = -off; }
    return { v: [a, b, c], n, off };
  };

  let faces = [
    makeFace(i0, i1, i2), makeFace(i0, i1, i3),
    makeFace(i0, i2, i3), makeFace(i1, i2, i3),
  ].filter(Boolean);

  const seeded = new Set([i0, i1, i2, i3]);

  // --- add the rest -------------------------------------------------------
  for (let pi = 0; pi < P.length; pi++) {
    if (seeded.has(pi)) continue;
    const p = P[pi];

    const visible = [];
    const kept = [];
    for (const f of faces) (dot(f.n, p) - f.off > eps ? visible : kept).push(f);
    if (visible.length === 0) continue;   // inside the hull already

    // The horizon is the set of edges on exactly one visible face.
    const edgeCount = new Map();
    for (const f of visible) {
      for (let e = 0; e < 3; e++) {
        const a = f.v[e], b = f.v[(e + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const rec = edgeCount.get(key);
        if (rec) rec.n++; else edgeCount.set(key, { a, b, n: 1 });
      }
    }

    faces = kept;
    for (const { a, b, n } of edgeCount.values()) {
      if (n !== 1) continue;
      const f = makeFace(a, b, pi);
      if (f) faces.push(f);
    }
  }

  return { faces, points: P, interior };
}

/**
 * Radial distance from the origin to the hull boundary along `d`.
 * Requires the origin to be inside the hull.
 */
export function hullRadius(hull, dx, dy, dz) {
  let r = Infinity;
  for (const f of hull.faces) {
    const c = f.n[0] * dx + f.n[1] * dy + f.n[2] * dz;
    if (c <= 1e-9) continue;             // face is behind or parallel to the ray
    const t = f.off / c;
    if (t < r) r = t;
  }
  return r;
}

/**
 * Volume of the hull: each face's plane is `off` from the origin, so the
 * tetrahedron over it is off * area / 3. Valid because the origin is inside,
 * which makes every `off` positive.
 */
export function hullVolume(hull) {
  let v = 0;
  for (const f of hull.faces) {
    const [a, b, c] = f.v.map((i) => hull.points[i]);
    const area = norm(cross(sub(b, a), sub(c, a))) / 2;
    v += (f.off * area) / 3;
  }
  return v;
}
