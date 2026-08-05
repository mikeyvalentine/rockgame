// How well a stone would skip, from its own geometry.
//
// This file used to also *generate* rock meshes — noise-displaced icospheres,
// optionally carved by half-spaces for angular stone. All of that has been
// removed: the scanned stones in `public/assets/river_rocks.glb` are the only
// source of geometry now, and the generated ones read as blobs beside them.
// See src/assetRocks.js.

import { clamp01 } from "./noise.js";

/** 0..1 rating of how well a stone would skip, plus a one-line verdict. */
export function skipRating(metrics) {
  const [a, b, c] = metrics.sortedCm; // a >= b >= c, centimetres
  const flatness = c / a;
  const roundness = b / a;
  const g = metrics.massGrams;

  const sFlat = clamp01(1 - Math.abs(flatness - 0.20) / 0.26);
  const sRound = clamp01((roundness - 0.55) / 0.33);
  const sMass = clamp01(1 - Math.abs(g - 165) / 175);
  const score = 0.45 * sFlat + 0.28 * sRound + 0.27 * sMass;

  let verdict;
  if (score > 0.82) verdict = "That's the one. Perfectly flat, sits right in the hand.";
  else if (score > 0.65) verdict = "Good skipper. Worth keeping.";
  else if (score > 0.45) verdict = flatness > 0.35 ? "Too thick — it'll plunge." : "Decent, but awkward in the hand.";
  else if (g > 400) verdict = "Way too heavy. Put it back.";
  else if (g < 40) verdict = "Too light, the wind will take it.";
  else verdict = "Wrong shape. Keep looking.";

  return { score, stars: Math.max(1, Math.round(score * 5)), verdict, flatness, roundness };
}
