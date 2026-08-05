// Archetype presets — the parameter sets that make a rock read as a *kind* of
// rock. Each is a family, not a single stone: everything here is jittered per
// seed inside makeShape, so one archetype yields an unlimited number of rocks
// that still obviously came from the same beach.
//
// `weight` is how common the family is in a mixed field. Real shingle is mostly
// two or three lithologies with the odd oddity, and a field with an even mix of
// six looks like a sample tray rather than a beach.
//
// Tuned against photographs of actual river shingle and skipping-stone beaches.
// Three things about real beds that the first pass got wrong:
//
//   - they are far *smoother* than intuition suggests. A stone that has been in
//     moving water is polished; visible lumps and pits are the exception, so
//     `wear` is high nearly everywhere and `lumpAmp` and `pitAmp` are small;
//   - they are far *flatter*. Most beach and river pebbles are Zingg discs or
//     blades, not ovoids — which is why a shingle bank looks stacked rather
//     than piled, and why skipping stones are easy to find;
//   - angular stones are rare. Maybe one in twenty has a fresh fracture face,
//     so flint's weight is low. It earns its place by breaking the uniformity,
//     not by being common.
//
// `roughness` here is the *found-in-the-shingle* state, not a fixed appearance.
// rockMaterial.js reads it as one end of a polish curve every archetype now
// has — the other end is a uniform glossy, high-sheen finish reached by
// tumbling, same mechanism the treasures use. Do not confuse this with `wear`
// below, which is a shape parameter baked into the geometry at generation
// time (how rounded the facets are) and has nothing to do with material
// shading. These ranges were raised across the board — flint and quartz were
// glossy enough raw that they showed a visible specular glint even before any
// tumbling, which is backwards: a stone should have to earn its shine.

import { TREASURES } from "./treasures.js";

/** @typedef {import("./shape.js").makeShape} Shape */

const ROCKS = {
  slate: {
    label: "Slate",
    weight: 0.3,
    // The classic skipping stone: a thin disc that broke along its bedding.
    axes: [1, 0.74, 0.22],
    exponent: 2.6,
    facets: 2, facetBite: [0.52, 0.72], sideFacets: [3, 6], sideBite: [0.62, 0.94], sideTilt: 0.3, facetRound: [0.015, 0.055], facetWobble: 0.13,
    lobes: [2, 4], lobeOffset: [0.22, 0.48], lobeRadius: [0.60, 0.86], lobeBlend: [0.45, 0.90],
    beddingBias: 0.92, beddingAmp: 0.055, beddingFreq: 9,
    lumpAmp: 0.028, lumpFreq: 1.6, lumpOctaves: 3,
    pitAmp: 0, pitCount: 0, crackAmp: 0.010,
    wear: 0.68, wearJitter: 0.3, axisJitter: 0.30,
    sizeRange: [0.045, 0.105], sizeBias: 1.146,
    vein: 0.55, veinColour: [0.86, 0.87, 0.88], spot: 0.0, spotColour: [0.7,0.7,0.7],
    mottle: 0.55, band: 0.3,
    density: 2750,
    colour: [[0.20, 0.21, 0.24], [0.34, 0.35, 0.38]],
    roughness: [0.68, 0.84],
    grain: 1.4,   // how strongly the shared detail normal map is applied
  },

  granite: {
    label: "Granite cobble",
    weight: 0.26,
    // Rounded, near-equant, speckled. The workhorse of any shingle bank.
    axes: [1, 0.82, 0.52],
    exponent: 2.9,
    facets: 4, facetBite: [0.70, 0.92], sideFacets: [0, 0], sideBite: [0.78, 0.99], sideTilt: 0.45, facetRound: [0.030, 0.100], facetWobble: 0.1,
    lobes: [2, 4], lobeOffset: [0.28, 0.58], lobeRadius: [0.58, 0.92], lobeBlend: [0.60, 1.10],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.045, lumpFreq: 2.1, lumpOctaves: 4,
    pitAmp: 0.005, pitCount: 90, crackAmp: 0,
    wear: 0.88, wearJitter: 0.22, axisJitter: 0.24,
    sizeRange: [0.035, 0.095], sizeBias: 0.961,
    vein: 0.18, veinColour: [0.88, 0.87, 0.84], spot: 0.45, spotColour: [0.80, 0.72, 0.66],
    mottle: 0.45, band: 0.0,
    density: 2650,
    colour: [[0.44, 0.42, 0.40], [0.62, 0.59, 0.55]],
    roughness: [0.74, 0.88],
    grain: 1.9,
  },

  flint: {
    label: "Flint",
    weight: 0.09,
    // Conchoidal fracture: sharp, glassy, awkward. Deliberately low wear so the
    // fracture faces survive — this is the family that stops the field looking
    // uniformly tumbled.
    axes: [1, 0.78, 0.56],
    exponent: 1.9,
    facets: 7, facetBite: [0.58, 0.86], sideFacets: [0, 0], sideBite: [0.66, 0.95], sideTilt: 0.55, facetRound: [0.012, 0.050], facetWobble: 0.16,
    scoops: [2, 5], scoopOffset: [1.15, 1.90], scoopKeep: [0.74, 0.92], scoopBlend: [0.012, 0.060],
    lobes: [1, 3], lobeOffset: [0.30, 0.62], lobeRadius: [0.55, 0.88], lobeBlend: [0.40, 0.80],
    beddingBias: 0.15, beddingAmp: 0,
    lumpAmp: 0.026, lumpFreq: 2.6, lumpOctaves: 3,
    pitAmp: 0.004, pitCount: 30, crackAmp: 0.006,
    wear: 0.42, wearJitter: 0.25, axisJitter: 0.26,
    sizeRange: [0.030, 0.075], sizeBias: 0.791,
    vein: 0.35, veinColour: [0.90, 0.90, 0.88], spot: 0.1, spotColour: [0.6,0.6,0.6],
    mottle: 0.6, band: 0.0,
    density: 2600,
    colour: [[0.16, 0.15, 0.15], [0.30, 0.28, 0.26]],
    roughness: [0.58, 0.74],
    grain: 1.3,
  },

  sandstone: {
    label: "Sandstone",
    weight: 0.16,
    // Soft, so it wears fast and keeps almost no edges, but it holds its
    // bedding — the banding is the only thing telling you it is not granite.
    axes: [1, 0.80, 0.40],
    exponent: 3.2,
    facets: 3, facetBite: [0.66, 0.90], sideFacets: [1, 3], sideBite: [0.74, 0.98], sideTilt: 0.4, facetRound: [0.040, 0.120], facetWobble: 0.09,
    lobes: [2, 4], lobeOffset: [0.26, 0.54], lobeRadius: [0.60, 0.90], lobeBlend: [0.60, 1.10],
    beddingBias: 0.70, beddingAmp: 0.040, beddingFreq: 6,
    lumpAmp: 0.05, lumpFreq: 1.7, lumpOctaves: 4,
    pitAmp: 0.008, pitCount: 55, crackAmp: 0,
    wear: 0.93, wearJitter: 0.16, axisJitter: 0.24,
    sizeRange: [0.040, 0.100], sizeBias: 1.054,
    vein: 0.1, veinColour: [0.88, 0.84, 0.76], spot: 0.2, spotColour: [0.74, 0.64, 0.50],
    mottle: 0.5, band: 0.42,
    density: 2350,
    colour: [[0.52, 0.44, 0.34], [0.70, 0.60, 0.46]],
    roughness: [0.82, 0.95],
    grain: 2.1,
  },

  basalt: {
    label: "Basalt",
    weight: 0.13,
    // Dark, dense, vesicular. The pits are gas bubbles, so they want to be
    // deeper and less numerous than granite's speckle.
    axes: [1, 0.80, 0.50],
    exponent: 2.6,
    facets: 5, facetBite: [0.66, 0.88], sideFacets: [0, 0], sideBite: [0.72, 0.97], sideTilt: 0.45, facetRound: [0.025, 0.090], facetWobble: 0.11,
    lobes: [2, 3], lobeOffset: [0.28, 0.56], lobeRadius: [0.58, 0.90], lobeBlend: [0.55, 1.05],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.032, lumpFreq: 2.0, lumpOctaves: 3,
    pitAmp: 0.012, pitCount: 34, crackAmp: 0,
    wear: 0.8, wearJitter: 0.28, axisJitter: 0.22,
    sizeRange: [0.032, 0.082], sizeBias: 0.854,
    vein: 0.3, veinColour: [0.86, 0.86, 0.84], spot: 0.12, spotColour: [0.55, 0.55, 0.55],
    mottle: 0.55, band: 0.0,
    density: 2900,
    colour: [[0.13, 0.13, 0.14], [0.26, 0.25, 0.25]],
    roughness: [0.66, 0.82],
    grain: 1.7,
  },

  chert: {
    label: "Chert cobble",
    weight: 0.09,
    // Dark red-brown, dense and well rounded. Added to give the pebble_scan
    // surface a home: at luminance 84 with saturation 47 it is the only warm
    // *dark* texture in the set, and every existing family is either grey-dark
    // or warm-light. Dropping it onto one of those would have replaced a good
    // match with a worse one.
    axes: [1, 0.80, 0.55],
    exponent: 2.5,
    facets: 4, facetBite: [0.70, 0.92], sideFacets: [0, 0], sideBite: [0.76, 0.98], sideTilt: 0.45, facetRound: [0.028, 0.095], facetWobble: 0.10,
    lobes: [2, 3], lobeOffset: [0.28, 0.56], lobeRadius: [0.58, 0.90], lobeBlend: [0.55, 1.05],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.034, lumpFreq: 2.2, lumpOctaves: 3,
    pitAmp: 0.006, pitCount: 45, crackAmp: 0.004,
    wear: 0.86, wearJitter: 0.24, axisJitter: 0.23,
    sizeRange: [0.030, 0.080], sizeBias: 0.816,
    vein: 0.22, veinColour: [0.88, 0.84, 0.78], spot: 0.10, spotColour: [0.62, 0.48, 0.36],
    mottle: 0.55, band: 0.0,
    density: 2600,
    colour: [[0.30, 0.22, 0.16], [0.48, 0.36, 0.27]],
    roughness: [0.62, 0.78],
    grain: 1.6,
  },

  quartz: {
    label: "Quartz",
    weight: 0.06,
    // The rare white one you always pick up. Blocky, bright, low roughness.
    axes: [1, 0.84, 0.62],
    exponent: 2.2,
    facets: 6, facetBite: [0.62, 0.84], sideFacets: [0, 0], sideBite: [0.70, 0.96], sideTilt: 0.5, facetRound: [0.020, 0.080], facetWobble: 0.14,
    lobes: [1, 3], lobeOffset: [0.26, 0.54], lobeRadius: [0.58, 0.88], lobeBlend: [0.50, 0.95],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.022, lumpFreq: 2.4, lumpOctaves: 3,
    pitAmp: 0, pitCount: 0, crackAmp: 0.008,
    wear: 0.62, wearJitter: 0.3, axisJitter: 0.2,
    sizeRange: [0.025, 0.060], sizeBias: 0.645,
    vein: 0.12, veinColour: [0.95, 0.95, 0.93], spot: 0.15, spotColour: [0.85, 0.85, 0.82],
    mottle: 0.4, band: 0.0,
    density: 2650,
    colour: [[0.74, 0.73, 0.70], [0.92, 0.91, 0.88]],
    roughness: [0.55, 0.70],
    grain: 1.1,
  },
};

/**
 * Rock families plus the rare things hidden among them. Treasures are ordinary
 * archetypes to every other part of the system — same shape model, same shared
 * topology, same instancing — so nothing downstream needs to know they exist.
 * They differ only in carrying a `gem` block and a very small weight.
 */
export const ARCHETYPES = { ...ROCKS, ...TREASURES };

export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);
export const ROCK_NAMES = Object.keys(ROCKS);

/** Pick an archetype name by weight. */
export function pickArchetype(rng) {
  let total = 0;
  for (const n of ARCHETYPE_NAMES) total += ARCHETYPES[n].weight;
  let t = rng() * total;
  for (const n of ARCHETYPE_NAMES) {
    t -= ARCHETYPES[n].weight;
    if (t <= 0) return n;
  }
  return ARCHETYPE_NAMES[ARCHETYPE_NAMES.length - 1];
}
