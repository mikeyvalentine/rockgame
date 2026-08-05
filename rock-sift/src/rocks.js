// How well a stone would skip, from its own geometry — and the rarity tier the
// player actually sees.
//
// This file used to also *generate* rock meshes — noise-displaced icospheres,
// optionally carved by half-spaces for angular stone. All of that has been
// removed: the scanned stones in `public/assets/river_rocks.glb` are the only
// source of geometry now, and the generated ones read as blobs beside them.
// See src/assetRocks.js.

import { clamp01 } from "./noise.js";

/**
 * Rarity tiers, worst to best. The score thresholds are `min` (inclusive).
 *
 * The player never sees the underlying number — a stone reads as a colour and a
 * word, the way loot does. `docs/02-gathering.md` wants inspection to stay a
 * judgement call ("stat bars, not numbers... deliberately slightly ambiguous"),
 * and a tier is the least precise honest summary there is.
 */
export const RARITY_TIERS = [
  { key: "common", label: "Common", color: "#9ba1a6", min: 0.0 },
  { key: "uncommon", label: "Uncommon", color: "#4caf50", min: 0.45 },
  { key: "rare", label: "Rare", color: "#3b82f6", min: 0.66 },
  { key: "epic", label: "Epic", color: "#a855f7", min: 0.82 },
  { key: "legendary", label: "Legendary", color: "#f59e0b", min: 0.93 },
];

/** The tier a 0..1 score falls in. Never returns undefined — 0 lands on Common. */
export function rarityFor(score) {
  let tier = RARITY_TIERS[0];
  for (const t of RARITY_TIERS) if (score >= t.min) tier = t;
  return tier;
}

/**
 * BALANCE, 0..1 — how well the stone holds its trim once thrown.
 *
 * Mirror of `balanceFromStone()` in stone-skipping-physics/src/stoneSkipping.js,
 * which is the canonical version and carries the full derivation. Kept in sync by
 * hand because rock-sift does not depend on that package. The short version:
 * attitude is lost to precession at `Omega = Gamma / L`, the water's torque does not
 * care how heavy the stone is but the angular momentum resisting it does, so the
 * figure of merit is `mass / radius`.
 *
 * Note this is measured off the bounding dimensions, so it cannot see an off-centre
 * centre of mass — the solver's `comOffset` term has no counterpart here. A stone
 * that is lopsided *inside* will read better here than it throws.
 */
const BALANCE_MR_REFERENCE = 3.82; // kg/m — the reference stone, scores 0.5
export function balanceFromMetrics(metrics) {
  const [a, b] = metrics.sortedCm; // a >= b, centimetres
  const radiusM = a / 2 / 100;
  const massKg = metrics.massGrams / 1000;
  if (!(radiusM > 0) || !(massKg > 0)) return 0;
  const mOverR = massKg / radiusM;
  const gyro = mOverR / (mOverR + BALANCE_MR_REFERENCE);
  // An oblong face meets the water differently every half turn.
  const roundTerm = 1 - 0.35 * clamp01((1 - b / a) / 0.45);
  return clamp01(gyro * roundTerm);
}

/**
 * 0..1 skip score plus the rarity tier it earns.
 *
 * The score is a straight weighted sum of the things that decide a run. Note that
 * `sMass` and `sBalance` deliberately pull against each other: a heavy stone holds
 * its attitude beautifully and is a pig to throw. That tension is the reason
 * `docs/02-gathering.md` can say "the best rocks are not the hardest rocks" — the
 * optimum is a band, not an extreme.
 */
export function skipRating(metrics) {
  const [a, b, c] = metrics.sortedCm; // a >= b >= c, centimetres
  const flatness = c / a;
  const roundness = b / a;
  const g = metrics.massGrams;

  const sFlat = clamp01(1 - Math.abs(flatness - 0.2) / 0.26);
  const sRound = clamp01((roundness - 0.55) / 0.33);
  // Throwability. A GATE, not an addend: a rock you cannot throw is not a good
  // skipper however pretty its proportions are. As a fourth weighted term a 1.5 kg
  // boulder scored well on flatness, roundness and balance, failed only this, and
  // still came out Uncommon.
  const throwable = clamp01(1 - Math.abs(g - 165) / 175);
  // Balance, renormalised for scoring. The physics value saturates — 0.5 is the
  // reference stone and realistic rocks land 0.2-0.6 — so it is rescaled here
  // against what a stone can actually reach rather than against 1.
  const sBalance = clamp01(balanceFromMetrics(metrics) / 0.65);
  const score = (0.4 * sFlat + 0.22 * sRound + 0.38 * sBalance) * throwable;

  let verdict;
  if (score > 0.82) verdict = "That's the one. Perfectly flat, sits right in the hand.";
  else if (score > 0.65) verdict = "Good skipper. Worth keeping.";
  else if (score > 0.45) verdict = flatness > 0.35 ? "Too thick — it'll plunge." : "Decent, but awkward in the hand.";
  else if (g > 400) verdict = "Way too heavy. Put it back.";
  else if (g < 40) verdict = "Too light, the wind will take it.";
  else verdict = "Wrong shape. Keep looking.";

  return { score, rarity: rarityFor(score), verdict, flatness, roundness, balance: sBalance };
}
