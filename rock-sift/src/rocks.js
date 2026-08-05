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
 * Rarity tiers, worst to best. Thresholds are `min` (inclusive).
 *
 * The player never sees the underlying number — a stone reads as a colour and a
 * word, the way loot does.
 */
export const RARITY_TIERS = [
  { key: "common", label: "Common", color: "#9ba1a6", min: 0.0 },
  { key: "uncommon", label: "Uncommon", color: "#4caf50", min: 0.45 },
  { key: "rare", label: "Rare", color: "#3b82f6", min: 0.66 },
  { key: "epic", label: "Epic", color: "#a855f7", min: 0.82 },
  { key: "legendary", label: "Legendary", color: "#f59e0b", min: 0.93 },
];

/** The tier a 0..1 score falls in. Never undefined — 0 lands on Common. */
export function rarityFor(score) {
  let tier = RARITY_TIERS[0];
  for (const t of RARITY_TIERS) if (score >= t.min) tier = t;
  return tier;
}

/**
 * Every stat is scored as DIVERGENCE FROM THE IDEAL SKIPPING STONE, not as a raw
 * magnitude. 5/5 mass means "the mathematically right mass", not "heavy" — so a
 * boulder and a pebble both score badly on mass, from opposite directions, and the
 * scale reads the same way for every stat: more pips is closer to perfect.
 *
 * Targets come from the literature collected in
 * stone-skipping-physics/docs/PHYSICS-NOTES.md section 8, not from taste:
 *
 *   mass       100-200 g is the good band; the solver's validated default is 172 g
 *              (its energy matched the Splash Lab's measured 164 J to within 5%)
 *   diameter   5-10 cm across; the skimming championship caps entries at 76 mm
 *   flatness   thickness ratio lambda = R/d wants 5-10, and flatness (thickness over
 *              longest face dimension) is 1/(2*lambda), so the ideal is ~0.075.
 *              NOTE this is much thinner than the 0.20 the old rating centred on.
 *   roundness  a round face meets the water the same way every rotation; an oblong
 *              one is forced at spin frequency
 *
 * `tolerance` is the divergence at which a stat scores zero.
 */
export const STONE_STAT_TARGETS = {
  mass: { label: "mass", ideal: 170, tolerance: 150, unit: "g" },
  size: { label: "size", ideal: 8.5, tolerance: 4.5, unit: "cm" },
  flatness: { label: "flatness", ideal: 0.075, tolerance: 0.14, unit: "" },
};

/**
 * How much of the flatness score an entirely oblong face can take away, and the
 * b/a shortfall at which that penalty is fully paid.
 */
const FLATNESS_OBLONG_WEIGHT = 0.45;
const FLATNESS_OBLONG_TOLERANCE = 0.45;

/**
 * Relative weights in the overall score. Flatness leads because a stone that is not
 * flat does not plane at all — every other virtue is moot if it plunges.
 *
 * Roughness is deliberately absent. It exists in the solver as a skin-friction
 * multiplier, but it is not a rated stat: it is close to invisible on a real stone
 * and its effect is a fraction of a percent of a run.
 */
const STAT_WEIGHTS = { flatness: 0.45, balance: 0.3, size: 0.25 };

/**
 * FLATNESS, 0..1 — one stat for "how much like a skipping disc is this".
 *
 * Flatness and face-shape used to be two stats, and that was wrong in a way worth
 * recording: "roundness" meant the face ellipse ratio b/a, so a **sphere scored
 * 5/5** on it — a ball rated ideal. The word is ambiguous. A circular *face* is
 * good; a *round solid* is the worst possible skipping stone. One stat now measures
 * both, and a ball reads 0/5 as it should.
 *
 * Thinness is the dominant term (`c/a` against the ideal 0.075), scaled down for an
 * oblong face, which meets the water differently every half turn instead of
 * presenting the same profile each rotation.
 *
 * Note `b/a` also appears inside `balanceFromMetrics` for that same physical reason,
 * so an oblong stone is marked down twice — once for being a poor disc, once for the
 * forcing that causes. That is deliberate but it is a real overlap, which is why the
 * penalty here is partial rather than a gate.
 */
export function flatnessScore(metrics) {
  const [a, b, c] = metrics.sortedCm; // a >= b >= c
  if (!(a > 0)) return 0;
  const thin = scoreAgainst(c / a, STONE_STAT_TARGETS.flatness);
  const oblong = clamp01((1 - b / a) / FLATNESS_OBLONG_TOLERANCE);
  return clamp01(thin * (1 - FLATNESS_OBLONG_WEIGHT * oblong));
}

/** 0..1 for one stat: 1 at the ideal, falling to 0 at `tolerance` away. */
function scoreAgainst(value, target) {
  return clamp01(1 - Math.abs(value - target.ideal) / target.tolerance);
}

const BALANCE_MR_REFERENCE = 3.82; // kg/m — the reference stone, scores 0.5

/**
 * BALANCE, 0..1 — how well the stone holds its trim once thrown.
 *
 * Mirror of `balanceFromStone()` in stone-skipping-physics/src/stoneSkipping.js,
 * which is canonical and carries the derivation. Short version: attitude is lost to
 * precession at `Omega = Gamma / L`; the water's torque does not care how heavy the
 * stone is but the angular momentum resisting it does, so the figure of merit is
 * `mass / radius`. A tiny stone is therefore badly balanced, not well balanced.
 *
 * Measured off bounding dimensions, so it cannot see an off-centre centre of mass —
 * the solver's `comOffset` term has no counterpart here. A stone that is lopsided
 * *inside* reads better here than it throws.
 */
export function balanceFromMetrics(metrics) {
  const [a, b] = metrics.sortedCm; // a >= b, centimetres
  const radiusM = a / 2 / 100;
  const massKg = metrics.massGrams / 1000;
  if (!(radiusM > 0) || !(massKg > 0)) return 0;
  const mOverR = massKg / radiusM;
  const gyro = mOverR / (mOverR + BALANCE_MR_REFERENCE);
  const roundTerm = 1 - 0.35 * clamp01((1 - b / a) / 0.45);
  return clamp01(gyro * roundTerm);
}

/**
 * Rate a stone against the ideal skipper.
 *
 * Returns per-stat 0..1 scores (and 0..5 pip counts for display), an overall score,
 * and the rarity tier it earns. The player is shown pips and a tier — never the
 * numbers, which would turn a judgement call into a readout.
 */
export function skipRating(metrics) {
  const [a, b, c] = metrics.sortedCm; // a >= b >= c, centimetres
  const flatness = c / a;
  const roundness = b / a;

  const stats = {
    mass: scoreAgainst(metrics.massGrams, STONE_STAT_TARGETS.mass),
    size: scoreAgainst(a, STONE_STAT_TARGETS.size),
    flatness: flatnessScore(metrics),
    // Balance is already a divergence-style score: it peaks for a stone whose mass
    // and radius are in the right relationship, and falls off both ways. Renormalised
    // against what a stone can actually reach (the raw curve saturates around 0.7).
    balance: clamp01(balanceFromMetrics(metrics) / 0.65),
  };

  // Mass gates rather than contributes. A rock you cannot throw is not a good
  // skipper however good its proportions are — as one weighted term among several a
  // 1.5 kg boulder scored well on shape, failed only this, and still came out
  // Uncommon.
  const shape =
    STAT_WEIGHTS.flatness * stats.flatness +
    STAT_WEIGHTS.balance * stats.balance +
    STAT_WEIGHTS.size * stats.size;
  const score = clamp01(shape * stats.mass);

  const pips = {};
  for (const k of Object.keys(stats)) pips[k] = Math.round(stats[k] * 5);

  // The verdict names the WORST stat, so the player learns which way a stone missed
  // rather than just that it did.
  const worst = Object.keys(stats).reduce((lo, k) => (stats[k] < stats[lo] ? k : lo), "mass");
  let verdict;
  if (score > 0.82) verdict = "That's the one. Everything about it is right.";
  else if (score > 0.65) verdict = "Good skipper. Worth keeping.";
  else if (worst === "mass") {
    verdict = metrics.massGrams > STONE_STAT_TARGETS.mass.ideal
      ? "Too heavy to throw properly." : "Too light — the wind will take it.";
  } else if (worst === "flatness") {
    // Name whichever way it failed to be a disc — too thick, too oblong, or too thin.
    if (roundness < 0.6) verdict = "Too oblong — it'll wobble every turn.";
    else if (flatness > STONE_STAT_TARGETS.flatness.ideal) verdict = "Too thick — it'll plunge.";
    else verdict = "Thin as a wafer, it won't hold a line.";
  } else if (worst === "balance") verdict = "Won't hold its attitude. Dies early.";
  else verdict = "Wrong size for the hand.";

  return { score, stats, pips, rarity: rarityFor(score), verdict, flatness, roundness };
}
