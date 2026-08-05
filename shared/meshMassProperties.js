// Exact rigid-body mass properties from a closed triangle mesh, and the shape
// descriptors the game grades rocks on.
//
// Nothing here is an estimate. For a uniform-density mesh the volume, centre of
// mass and inertia tensor are exact, by tetrahedron decomposition: every triangle
// forms a tetrahedron with the origin, each contributes a signed amount, and the
// signs cancel for the parts outside the solid. `signedVolume` in rock-sift already
// does the volume term; this is the same loop carrying two more accumulators.
//
// Why bother, rather than fitting a disc by eye: the inertia tensor IS the shape,
// as far as a spinning stone is concerned. A rock wobbles because its mass is not
// distributed symmetrically about the axis it spins on, and that fact lives in the
// tensor and nowhere else. Deriving stats from it is what makes a rock's appearance
// and its behaviour the same thing.
//
// Reference: Blow & Binstock, "How to find the inertia tensor (or other mass
// properties) of a triangle mesh"; Mirtich, "Fast and Accurate Computation of
// Polyhedral Mass Properties", J. Graphics Tools 1(2), 1996.

/** Canonical tetrahedron covariance, times 120. */
const C_CANON = [
  [2, 1, 1],
  [1, 2, 1],
  [1, 1, 2],
];

const mul3 = (A, B) => {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      M[i][j] = s;
    }
  return M;
};
const transpose3 = (A) => [
  [A[0][0], A[1][0], A[2][0]],
  [A[0][1], A[1][1], A[2][1]],
  [A[0][2], A[1][2], A[2][2]],
];

/**
 * Volume, centre of mass and inertia tensor of a closed triangle mesh.
 *
 * @param positions flat [x,y,z, ...] vertex array
 * @param indices   flat triangle index array
 * @param density   kg/m^3. Pass 1 for shape-only work; mass scales linearly.
 * @returns {{volume, mass, com, inertia, degenerate}} `inertia` is about the CENTRE
 *          OF MASS as {xx,yy,zz,xy,xz,yz}, matching the solver's tensor layout.
 *          `volume` is signed-corrected (absolute), so winding order does not matter.
 */
export function massProperties(positions, indices, density = 1) {
  let vol = 0;
  const cx = [0, 0, 0];
  // Covariance about the ORIGIN, accumulated then shifted to the CoM at the end.
  let C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  for (let f = 0; f < indices.length; f += 3) {
    const ia = indices[f] * 3, ib = indices[f + 1] * 3, ic = indices[f + 2] * 3;
    const w1 = [positions[ia], positions[ia + 1], positions[ia + 2]];
    const w2 = [positions[ib], positions[ib + 1], positions[ib + 2]];
    const w3 = [positions[ic], positions[ic + 1], positions[ic + 2]];

    // A has the three tetrahedron edge vectors as COLUMNS.
    const A = [
      [w1[0], w2[0], w3[0]],
      [w1[1], w2[1], w3[1]],
      [w1[2], w2[2], w3[2]],
    ];
    const det =
      A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
      A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
      A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

    const tetVol = det / 6;
    vol += tetVol;
    // Tetrahedron centroid is the mean of its four vertices, one of which is the
    // origin — hence /4 rather than /3.
    for (let i = 0; i < 3; i++) cx[i] += tetVol * (w1[i] + w2[i] + w3[i]) / 4;

    const Ct = mul3(mul3(A, C_CANON), transpose3(A));
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) C[i][j] += (det / 120) * Ct[i][j];
  }

  const degenerate = !(Math.abs(vol) > 1e-20);
  if (degenerate) {
    return {
      volume: 0, mass: 0, com: { x: 0, y: 0, z: 0 }, degenerate: true,
      inertia: { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 },
    };
  }

  // A mesh wound inside-out yields a negative volume; the covariance picks up the
  // same sign, so flipping both keeps them consistent rather than corrupting the
  // tensor.
  if (vol < 0) {
    vol = -vol;
    for (let i = 0; i < 3; i++) {
      cx[i] = -cx[i];
      for (let j = 0; j < 3; j++) C[i][j] = -C[i][j];
    }
  }
  const com = { x: cx[0] / vol, y: cx[1] / vol, z: cx[2] / vol };

  // Shift covariance from the origin to the centre of mass, then convert to an
  // inertia tensor: I = tr(C) * Identity - C.
  const c = [com.x, com.y, com.z];
  const Ccm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) Ccm[i][j] = C[i][j] - vol * c[i] * c[j];

  const tr = Ccm[0][0] + Ccm[1][1] + Ccm[2][2];
  const k = density;
  return {
    volume: vol,
    mass: vol * density,
    com,
    degenerate: false,
    inertia: {
      xx: k * (tr - Ccm[0][0]),
      yy: k * (tr - Ccm[1][1]),
      zz: k * (tr - Ccm[2][2]),
      xy: k * -Ccm[0][1],
      xz: k * -Ccm[0][2],
      yz: k * -Ccm[1][2],
    },
  };
}

/**
 * Principal moments and axes of a symmetric 3x3 inertia tensor, by cyclic Jacobi.
 *
 * Returns moments DESCENDING (`I1 >= I2 >= I3`) with matching unit axes. `I1`'s axis
 * is the one a stone naturally spins about — for a flat rock it is the face normal.
 */
export function principalAxes(I) {
  let a = [
    [I.xx, I.xy, I.xz],
    [I.xy, I.yy, I.yz],
    [I.xz, I.yz, I.zz],
  ];
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        const A2 = a.map((r) => r.slice());
        for (let i = 0; i < 3; i++) {
          A2[i][p] = cos * a[i][p] - sin * a[i][q];
          A2[i][q] = sin * a[i][p] + cos * a[i][q];
        }
        const A3 = A2.map((r) => r.slice());
        for (let j = 0; j < 3; j++) {
          A3[p][j] = cos * A2[p][j] - sin * A2[q][j];
          A3[q][j] = sin * A2[p][j] + cos * A2[q][j];
        }
        a = A3;
        const V2 = v.map((r) => r.slice());
        for (let i = 0; i < 3; i++) {
          V2[i][p] = cos * v[i][p] - sin * v[i][q];
          V2[i][q] = sin * v[i][p] + cos * v[i][q];
        }
        v = V2;
      }
    }
  }

  const cols = [0, 1, 2].map((j) => ({
    moment: a[j][j],
    axis: { x: v[0][j], y: v[1][j], z: v[2][j] },
  }));
  cols.sort((p, q) => q.moment - p.moment);
  return {
    moments: cols.map((c) => c.moment),
    axes: cols.map((c) => c.axis),
  };
}

/**
 * Shape descriptors a rock is graded on, all read off the inertia tensor.
 *
 * These are orientation-free and scale-free, which is what makes them honest: they
 * describe the rock itself, not how it happens to be sitting or how big it is.
 *
 * - `flatness` 0..1. Uses the **perpendicular axis theorem**: for any flat lamina
 *   `I1 = I2 + I3` exactly, so `I1 / (I2 + I3)` is 1 for a perfect plate and 0.5 for
 *   a sphere. Rescaled to 0..1, so **a ball reads 0 and a wafer reads 1** with no
 *   tuning constant anywhere.
 * - `asymmetry` 0..1. `|I2 - I3| / (I2 + I3)`, the difference between the two
 *   transverse moments: 0 when the rock is axisymmetric about its spin axis (a disc),
 *   rising as it becomes oblong. This is the *forced wobble* term — an oblong stone
 *   is driven at spin frequency because it does not present the same profile twice.
 * - `lopsidedness` 0..1. How far the centre of mass sits from the middle of the
 *   bounding box, as a fraction of the rock's half-span. A wedge-shaped stone reads
 *   high. This is the term that feeds the solver's `comOffset`.
 */
export function shapeDescriptors(positions, indices, density = 1) {
  const mp = massProperties(positions, indices, density);
  if (mp.degenerate) {
    return { ...mp, flatness: 0, asymmetry: 0, lopsidedness: 0, moments: [0, 0, 0], axes: null, span: [0, 0, 0] };
  }
  const { moments, axes } = principalAxes(mp.inertia);
  const [I1, I2, I3] = moments;

  const transverse = I2 + I3;
  const flatnessRaw = transverse > 0 ? I1 / transverse : 0.5;
  const flatness = Math.min(1, Math.max(0, (flatnessRaw - 0.5) * 2));
  const asymmetry = transverse > 0 ? Math.min(1, Math.abs(I2 - I3) / transverse) : 0;

  // Bounding box, for the lopsidedness reference and the reported span.
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const p = positions[i + k];
      if (p < lo[k]) lo[k] = p;
      if (p > hi[k]) hi[k] = p;
    }
  }
  const centre = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const span = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const halfSpan = Math.max(...span) / 2;
  const d = Math.hypot(mp.com.x - centre[0], mp.com.y - centre[1], mp.com.z - centre[2]);
  const lopsidedness = halfSpan > 0 ? Math.min(1, d / halfSpan) : 0;

  return { ...mp, flatness, asymmetry, lopsidedness, moments, axes, span: span.sort((x, y) => y - x) };
}
