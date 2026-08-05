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

// The rating is NOT reimplemented here. It used to be — a copy carrying the note
// "kept identical to rock-sift's src/rocks.js so the two stay interchangeable" — and
// the two drifted anyway: this copy was still on the old star scoring, with no rarity
// tiers, no balance term, and a flatness curve centred on 0.20 that the literature
// does not support. Since rocks come from the forge, the stale copy was the live one.
export { skipRating, RARITY_TIERS, rarityFor, STONE_STAT_TARGETS } from "../../../shared/rockRating.js";
