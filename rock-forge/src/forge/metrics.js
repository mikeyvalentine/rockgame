// Physical measurements taken from the baked geometry, not from the parameters
// that produced it. The parameters describe an intent; the mesh is what the
// player picks up, and after fracture cuts and pitting the two disagree by
// enough to matter to a skip rating.

/** Volume of a closed mesh, by summing signed tetrahedra to the origin. */
export function meshVolume(dirs, radii, indices) {
  let v = 0;
  for (let f = 0; f < indices.length; f += 3) {
    const ia = indices[f], ib = indices[f + 1], ic = indices[f + 2];
    const ax = dirs[ia * 3] * radii[ia], ay = dirs[ia * 3 + 1] * radii[ia], az = dirs[ia * 3 + 2] * radii[ia];
    const bx = dirs[ib * 3] * radii[ib], by = dirs[ib * 3 + 1] * radii[ib], bz = dirs[ib * 3 + 2] * radii[ib];
    const cx = dirs[ic * 3] * radii[ic], cy = dirs[ic * 3 + 1] * radii[ic], cz = dirs[ic * 3 + 2] * radii[ic];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

/** Axis-aligned extents. The shape model already aligns x/z/y to long/mid/short. */
export function meshSpan(dirs, radii, vertexCount) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let c = 0; c < 3; c++) {
      const v = dirs[i * 3 + c] * radii[i];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** Largest distance from the centre — the bounding sphere used for LOD and packing. */
export function boundingRadius(radii, vertexCount) {
  let r = 0;
  for (let i = 0; i < vertexCount; i++) if (radii[i] > r) r = radii[i];
  return r;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 0..1 rating of how well a stone would skip, plus a one-line verdict.
 * Kept identical to rock-sift's src/rocks.js so the two stay interchangeable.
 */
export function skipRating({ sortedCm, massGrams }) {
  const [a, b, c] = sortedCm;
  const flatness = c / a;
  const roundness = b / a;

  const sFlat = clamp01(1 - Math.abs(flatness - 0.20) / 0.26);
  const sRound = clamp01((roundness - 0.55) / 0.33);
  const sMass = clamp01(1 - Math.abs(massGrams - 165) / 175);
  const score = 0.45 * sFlat + 0.28 * sRound + 0.27 * sMass;

  let verdict;
  if (score > 0.82) verdict = "That's the one. Perfectly flat, sits right in the hand.";
  else if (score > 0.65) verdict = "Good skipper. Worth keeping.";
  else if (score > 0.45) verdict = flatness > 0.35 ? "Too thick — it'll plunge." : "Decent, but awkward in the hand.";
  else if (massGrams > 400) verdict = "Way too heavy. Put it back.";
  else if (massGrams < 40) verdict = "Too light, the wind will take it.";
  else verdict = "Wrong shape. Keep looking.";

  return { score, stars: Math.max(1, Math.round(score * 5)), verdict, flatness, roundness };
}
