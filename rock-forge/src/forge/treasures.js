// The things worth finding.
//
// A field of shingle is almost entirely trash — that is the point of sifting —
// and these are what is hidden in it. They are ordinary archetypes as far as
// the rest of the system is concerned: same shape model, same shared topology,
// same instancing. Two things make them different.
//
// **They are found rough.** A mineral in a river bed has not been tumbled by
// anyone; it is a crystal, a nodule or a shard. So the shapes below describe
// the *raw* state — angular for amethyst and obsidian, botryoidal for
// malachite, nodular for agate, flat frosted plates for sea glass — and
// `polish` is a separate axis that a tumbling mechanic can later drive from 0
// to 1 to raise a stone's worth. Most kinds start at `startPolish: 0`; sea
// glass's "rough" state is already frosted rather than jagged, but it is still
// 0 here, meant to look duller and less lustrous than its tumbled/wetted
// state. Obsidian is the one exception, at 0.15 — freshly broken glass is
// already glassy along its conchoidal faces before anything tumbles it.
//
// **Nothing here is transparent. Sea glass is opaque, and it glows.**
//
// This went through two wrong versions before landing here, and both are worth
// recording because the failure was the same shape twice.
//
// The first cut gave sea glass ordinary subsurface translucency and nothing
// else — light diffusing *within* the body, with nothing behind the piece ever
// showing through it — so it read as painted plastic. The second cut fixed
// that by adding real alpha transmission (`alphaFace`/`alphaEdge`, blended by
// view angle) and, on the reasoning that "it is glass, glass is see-through",
// extended the same alpha path to the minerals too. Both looked exactly as
// wrong as their reasoning: a jade cobble you can see the beach through is not
// a jade cobble, and a piece of sea glass you can see through is not sea glass
// either — decades of tumbling etch a surface so thoroughly that it stops
// behaving like a clear material at all. The pitting scatters light *before*
// it can pass through, so what reaches the eye is diffuse and pale and glowing
// from within, never a transparent window onto whatever is behind it.
//
// So every treasure here — sea glass included — is fundamentally the same
// thing: an *opaque solid that glows*. Light goes in, scatters, comes back out
// the surface it went in through. That is what subsurface translucency alone
// already models, correctly, with no alpha blending involved.
//
// Sea glass keeps one narrow exception on top of that: `alphaEdge` sits just
// below 1, so a thin band right at the silhouette lets a hint of background
// through. That is the familiar thin-edge cue — a chip of glass reads solid
// across its face and faintly see-through at its rim — and it is the
// difference between "frosted glass" and "painted stone" without reopening
// the wispy mistake, because `alphaFace` stays at 1 and the body never thins.
// Everything else keeps both values at 1 and never enters the transparent
// pass at all.
//
// What actually distinguishes sea glass from amethyst or jade is not
// transparency, it is *how rough and how strongly it scatters*: very high
// roughness so specular highlights blur into a soft sheen rather than a
// mirror glint, strong translucency so a real amount of light gets in and
// scatters before leaving, and `frost` pulling the albedo toward a pale
// version of its own colour on top of that.
//
// **They are translucent.** That is the whole reason a gem reads as a gem
// rather than as a coloured rock, and it is the one thing no amount of albedo
// work substitutes for. Babylon's PBR carries it natively: subsurface
// translucency with a tint and a thickness, plus iridescence for opal, plus a
// clear coat that `polish` fades in.
//
// `pattern` picks how the shared variation map is read:
//   flat        one colour, modulated only by mottling
//   planar      parallel bands across the short axis   (agate)
//   concentric  rings from the centre outward          (malachite)
//   cloudy      soft irregular blotches                (jade, opal)
//   veined      a network of contrasting lines         (turquoise)
//
// On top of the pattern, two imperfection layers. A real mineral is not a clean
// gradient between two colours — a bowl of tumbled jade is mottled with dark
// specks of chromite, rust-coloured patches where it has altered, and pale
// cloudy zones. `speck` scatters dark mineral inclusions from the Voronoi
// channel; `flaw` paints irregular patches of a contrasting colour from the
// vein channel. Without them the stones read as coloured plastic.

/** Weights are relative to the rock families, whose total is about 1.0. */
export const TREASURES = {
  seaglass: {
    label: "Sea glass",
    weight: 0.016,
    treasure: true,
    // Broken glass, not a pebble: flat plates with polygonal outlines and edges
    // the sea has knocked the sharpness off. This is slate's geometry, which is
    // why the side-cut machinery built for slate carries straight over.
    axes: [1, 0.80, 0.26],
    exponent: 2.4,
    facets: 2, facetBite: [0.50, 0.70], sideFacets: [3, 6], sideBite: [0.58, 0.92], sideTilt: 0.28,
    facetRound: [0.020, 0.070], facetWobble: 0.06,
    lobes: [0, 1], lobeOffset: [0.20, 0.42], lobeRadius: [0.62, 0.88], lobeBlend: [0.30, 0.70],
    beddingBias: 0.94, beddingAmp: 0, beddingFreq: 6,
    lumpAmp: 0.016, lumpFreq: 1.8, lumpOctaves: 2,
    pitAmp: 0, pitCount: 0, crackAmp: 0,
    wear: 0.55, wearJitter: 0.25, axisJitter: 0.30,
    sizeRange: [0.012, 0.045], sizeBias: 0.38,
    density: 2500,
    // Seafoam and aqua dominate a real haul; cobalt and bottle green turn up
    // now and then; red is the one people actually keep.
    gem: {
      pattern: "flat",
      colours: [[0.62, 0.84, 0.78], [0.78, 0.90, 0.84]],
      palette: [
        [0.58, 0.82, 0.76], [0.68, 0.86, 0.72], [0.80, 0.88, 0.84],
        [0.30, 0.48, 0.72], [0.22, 0.40, 0.26], [0.60, 0.20, 0.20],
      ],
      // Frosted, rough, and glowing from subsurface scattering — not a tinted
      // window. See the module note above for why this is opaque rather than
      // transparent.
      //
      // Roughness is the highest of anything in the set: a raw find should
      // barely show a specular highlight at all, just a soft milky sheen.
      // Translucency is likewise the highest here on purpose — a "good bit of
      // subsurface scattering" was the brief, and thickness is set so light
      // actually travels far enough through the piece to pick up its colour
      // before scattering back out, rather than bouncing off the first few
      // microns. `frost` then pulls the albedo toward a pale version of the
      // glass's own colour on top of that, which is what makes a raw piece
      // read as milky rather than saturated. Polishing backs off both the
      // roughness and the frost, which is what wetting a piece does.
      roughRaw: 0.95, roughPolished: 0.14,
      translucency: 0.92, tintDistance: 0.014, thickness: 0.024,
      speck: 0.10, speckColour: [0.55, 0.60, 0.58], flaw: 0.14, flawColour: [0.95, 0.97, 0.95],
      // Solid across the face, a hint of see-through right at the silhouette.
      // alphaFace stays 1 — dropping it is what made the whole piece wispy —
      // and the frost term pulls the rim partway back toward opaque, so the
      // effective rim opacity lands around 0.75 raw and clears as polish
      // removes the frost, exactly like wetting a piece.
      alphaFace: 1.0, alphaEdge: 0.62,
      iridescence: 0,
      frost: 0.78,
      startPolish: 0.0,
    },
  },

  amethyst: {
    label: "Amethyst",
    weight: 0.006,
    treasure: true,
    // Crystalline: sharp prisms, low wear, plenty of fracture faces.
    axes: [1, 0.72, 0.60],
    exponent: 1.7,
    facets: 9, facetBite: [0.52, 0.82], sideFacets: [3, 5], sideBite: [0.60, 0.90], sideTilt: 0.6,
    facetRound: [0.008, 0.030], facetWobble: 0.05,
    lobes: [0, 2], lobeOffset: [0.26, 0.52], lobeRadius: [0.56, 0.84], lobeBlend: [0.20, 0.50],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.018, lumpFreq: 2.4, lumpOctaves: 2,
    pitAmp: 0, pitCount: 0, crackAmp: 0.004,
    wear: 0.18, wearJitter: 0.20, axisJitter: 0.24,
    sizeRange: [0.014, 0.042], sizeBias: 0.40,
    density: 2650,
    gem: {
      pattern: "cloudy",
      colours: [[0.38, 0.24, 0.52], [0.66, 0.52, 0.80]],
      roughRaw: 0.55, roughPolished: 0.06,
      translucency: 1.0, tintDistance: 0.018, thickness: 0.014,
      speck: 0.22, speckColour: [0.12, 0.08, 0.18], flaw: 0.30, flawColour: [0.88, 0.86, 0.92],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 0,
      startPolish: 0,
    },
  },

  jade: {
    label: "Nephrite jade",
    weight: 0.005,
    treasure: true,
    // Tough and fibrous, so it does not fracture cleanly — river jade turns up
    // as smooth blocky boulders with a waxy skin.
    axes: [1, 0.84, 0.66],
    exponent: 2.7,
    facets: 4, facetBite: [0.70, 0.94], sideFacets: [1, 3], sideBite: [0.74, 0.98], sideTilt: 0.4,
    facetRound: [0.040, 0.110], facetWobble: 0.10,
    lobes: [2, 3], lobeOffset: [0.28, 0.54], lobeRadius: [0.60, 0.90], lobeBlend: [0.55, 1.00],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.030, lumpFreq: 1.9, lumpOctaves: 3,
    pitAmp: 0.004, pitCount: 40, crackAmp: 0,
    wear: 0.72, wearJitter: 0.22, axisJitter: 0.22,
    sizeRange: [0.020, 0.060], sizeBias: 0.55,
    density: 3000,
    gem: {
      pattern: "cloudy",
      colours: [[0.28, 0.40, 0.24], [0.56, 0.68, 0.44]],
      roughRaw: 0.68, roughPolished: 0.09,
      translucency: 0.55, tintDistance: 0.010, thickness: 0.020,
      speck: 0.45, speckColour: [0.08, 0.10, 0.05], flaw: 0.42, flawColour: [0.74, 0.72, 0.42],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 0,
      startPolish: 0,
    },
  },

  agate: {
    label: "Banded agate",
    weight: 0.007,
    treasure: true,
    // A nodule that grew in a gas cavity: rounded, lumpy, and banded right
    // through. Raw ones look like unremarkable grey pebbles until they are cut,
    // which is exactly the "worth more once tumbled" story.
    axes: [1, 0.86, 0.70],
    exponent: 2.8,
    facets: 3, facetBite: [0.76, 0.96], sideFacets: [0, 0], sideBite: [0.80, 0.99], sideTilt: 0.4,
    facetRound: [0.045, 0.120], facetWobble: 0.12,
    lobes: [3, 5], lobeOffset: [0.26, 0.50], lobeRadius: [0.60, 0.92], lobeBlend: [0.60, 1.10],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.042, lumpFreq: 2.0, lumpOctaves: 3,
    pitAmp: 0.006, pitCount: 50, crackAmp: 0,
    wear: 0.80, wearJitter: 0.20, axisJitter: 0.20,
    sizeRange: [0.018, 0.055], sizeBias: 0.50,
    density: 2600,
    gem: {
      pattern: "planar",
      colours: [[0.32, 0.22, 0.16], [0.86, 0.78, 0.66]],
      bandFreq: 2.6, bandWarp: 1.35,
      roughRaw: 0.72, roughPolished: 0.05,
      translucency: 0.45, tintDistance: 0.012, thickness: 0.016,
      speck: 0.18, speckColour: [0.16, 0.10, 0.06], flaw: 0.25, flawColour: [0.92, 0.88, 0.80],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 0,
      startPolish: 0,
    },
  },

  malachite: {
    label: "Malachite",
    weight: 0.004,
    treasure: true,
    // Botryoidal — it grows as fused bulbs, which is precisely what a handful of
    // strong overlapping lobes produces. The concentric banding follows those
    // bulbs outward.
    axes: [1, 0.88, 0.74],
    exponent: 2.4,
    facets: 2, facetBite: [0.82, 0.99], sideFacets: [0, 0], sideBite: [0.85, 0.99], sideTilt: 0.4,
    facetRound: [0.050, 0.140], facetWobble: 0.08,
    lobes: [4, 6], lobeOffset: [0.30, 0.60], lobeRadius: [0.55, 0.85], lobeBlend: [0.35, 0.75],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.026, lumpFreq: 2.2, lumpOctaves: 3,
    pitAmp: 0, pitCount: 0, crackAmp: 0,
    wear: 0.60, wearJitter: 0.20, axisJitter: 0.18,
    sizeRange: [0.015, 0.045], sizeBias: 0.42,
    density: 4000,
    gem: {
      pattern: "concentric",
      colours: [[0.06, 0.24, 0.14], [0.42, 0.76, 0.50]],
      bandFreq: 7.0, bandWarp: 0.85,
      roughRaw: 0.62, roughPolished: 0.05,
      translucency: 0.15, tintDistance: 0.006, thickness: 0.020,
      speck: 0.20, speckColour: [0.03, 0.10, 0.06], flaw: 0.18, flawColour: [0.72, 0.86, 0.70],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 0,
      startPolish: 0,
    },
  },

  turquoise: {
    label: "Turquoise",
    weight: 0.004,
    treasure: true,
    // Forms as crusts and nodules in host rock, so the dark "matrix" webbing is
    // not decoration — it is the rock it grew in, left behind in the cracks.
    axes: [1, 0.82, 0.62],
    exponent: 2.6,
    facets: 5, facetBite: [0.66, 0.90], sideFacets: [1, 3], sideBite: [0.72, 0.96], sideTilt: 0.5,
    facetRound: [0.025, 0.080], facetWobble: 0.14,
    lobes: [2, 4], lobeOffset: [0.28, 0.54], lobeRadius: [0.58, 0.88], lobeBlend: [0.45, 0.90],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.034, lumpFreq: 2.1, lumpOctaves: 3,
    pitAmp: 0.008, pitCount: 45, crackAmp: 0.006,
    wear: 0.50, wearJitter: 0.25, axisJitter: 0.22,
    sizeRange: [0.014, 0.040], sizeBias: 0.38,
    density: 2800,
    gem: {
      pattern: "veined",
      colours: [[0.22, 0.62, 0.66], [0.46, 0.80, 0.80]],
      veinColour: [0.14, 0.12, 0.10],
      veinAmount: 0.85,
      roughRaw: 0.70, roughPolished: 0.08,
      translucency: 0.10, tintDistance: 0.006, thickness: 0.018,
      speck: 0.35, speckColour: [0.10, 0.09, 0.07], flaw: 0.20, flawColour: [0.80, 0.76, 0.60],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 0,
      startPolish: 0,
    },
  },

  obsidian: {
    label: "Obsidian",
    weight: 0.006,
    treasure: true,
    // Volcanic glass, with no crystal structure at all, so it has no planes to
    // break along. It fractures conchoidally — in curved shell-shaped scoops
    // that meet at edges sharper than a scalpel. The scoops are what produce
    // that: flat cuts alone gave chunky faceted blocks, which is not how any
    // glass has ever broken.
    axes: [1, 0.66, 0.30],
    exponent: 1.6,
    facets: 8, facetBite: [0.50, 0.80], sideFacets: [2, 5], sideBite: [0.58, 0.90], sideTilt: 0.65,
    facetRound: [0.004, 0.016], facetWobble: 0.04,
    scoops: [4, 7], scoopOffset: [1.15, 1.90], scoopKeep: [0.66, 0.86], scoopBlend: [0.008, 0.045],
    lobes: [0, 1], lobeOffset: [0.28, 0.56], lobeRadius: [0.55, 0.85], lobeBlend: [0.15, 0.40],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.012, lumpFreq: 2.8, lumpOctaves: 2,
    pitAmp: 0, pitCount: 0, crackAmp: 0,
    wear: 0.12, wearJitter: 0.15, axisJitter: 0.26,
    sizeRange: [0.016, 0.050], sizeBias: 0.44,
    density: 2400,
    gem: {
      pattern: "flat",
      colours: [[0.030, 0.028, 0.034], [0.10, 0.09, 0.11]],
      roughRaw: 0.34, roughPolished: 0.03,
      translucency: 0.12, tintDistance: 0.004, thickness: 0.022,
      speck: 0.25, speckColour: [0.30, 0.30, 0.34], flaw: 0.12, flawColour: [0.45, 0.42, 0.40],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 0,
      startPolish: 0.15,
    },
  },

  opal: {
    label: "Opal",
    weight: 0.002,
    treasure: true,
    // The rarest thing in the bed. Its colour is not pigment at all — it is
    // diffraction from a lattice of silica spheres, which is thin-film
    // interference, which is exactly what Babylon's iridescence block models.
    axes: [1, 0.84, 0.68],
    exponent: 2.5,
    facets: 4, facetBite: [0.72, 0.94], sideFacets: [1, 3], sideBite: [0.76, 0.97], sideTilt: 0.45,
    facetRound: [0.030, 0.090], facetWobble: 0.10,
    lobes: [2, 4], lobeOffset: [0.26, 0.52], lobeRadius: [0.60, 0.90], lobeBlend: [0.50, 0.95],
    beddingBias: 0.0, beddingAmp: 0,
    lumpAmp: 0.028, lumpFreq: 2.0, lumpOctaves: 3,
    pitAmp: 0, pitCount: 0, crackAmp: 0,
    wear: 0.55, wearJitter: 0.25, axisJitter: 0.20,
    sizeRange: [0.012, 0.036], sizeBias: 0.34,
    density: 2100,
    gem: {
      pattern: "cloudy",
      colours: [[0.72, 0.74, 0.76], [0.92, 0.92, 0.90]],
      roughRaw: 0.60, roughPolished: 0.04,
      translucency: 0.90, tintDistance: 0.016, thickness: 0.012,
      speck: 0.15, speckColour: [0.40, 0.38, 0.36], flaw: 0.30, flawColour: [0.96, 0.94, 0.88],
      alphaFace: 1.0, alphaEdge: 1.0,
      iridescence: 1.0,
      startPolish: 0,
    },
  },
};

export const TREASURE_NAMES = Object.keys(TREASURES);

/** What fraction of a mixed field is worth picking up. */
export function treasureShare(rockTotalWeight = 1) {
  let t = 0;
  for (const k of TREASURE_NAMES) t += TREASURES[k].weight;
  return t / (t + rockTotalWeight);
}
