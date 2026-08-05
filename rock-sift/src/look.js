// Everything that decides how bright and how contrasty the shore reads.
//
// These knobs used to be split — tone mapping and the vignette in
// environment.js, ambient occlusion in main.js — which made "why is the scene so
// dark?" a question you had to answer by reading two files and holding the
// multiplication in your head. They are all here now, in the order they apply.
//
// They stack MULTIPLICATIVELY. A scene that looks too dark is usually not one
// setting being wrong, it is four being slightly heavy at once. In rough order
// of how much each one costs you:
//
//   ssao.base          floor of the ambient occlusion term. At 0.05 AO can pull
//                      a pixel almost to black, and in a packed bed of pebbles
//                      *every* pixel has an occluding neighbour. This is the
//                      first thing to raise.
//   ssao.totalStrength how hard that term is applied.
//   exposure/contrast  ACES compresses the midtones by design; contrast above 1
//                      pushes them down further.
//
// There is no vignette. There was, at weight 2.2, and it was a mistake: it is a
// framing device for a camera looking out at a scene, and this camera is looking
// down at a subject that fills the frame corner to corner. All it did was dim the
// stones at the edges of the bed and read as a dark ring closing in.
//
// Press O at runtime to toggle AO, which tells you in one keystroke how much of
// the darkness is coming from that term alone.

import { ImageProcessingConfiguration, SSAO2RenderingPipeline } from "@babylonjs/core";

export const LOOK = {
  exposure: 1.05,
  contrast: 1.15,

  ao: {
    strength: 1.1,
    base: 0.05,
    // AUDIT #B6: 8 samples, plain blur (was 16 + expensive bilateral). AO is
    // load-bearing for the bed's depth, but half the taps at a quarter-ish of
    // the blur cost reads the same at pebble scale. Raise samples first if the
    // contact shadow starts crawling.
    samples: 8,
    radiusMetres: 0.02,
    maxDistanceMetres: 4,
  },
};

export function applyLook(scene, camera, { U }) {
  // Filmic response, so the HDR sky's highlights roll off instead of clipping.
  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = LOOK.exposure;
  ip.contrast = LOOK.contrast;
  ip.vignetteEnabled = false; // see the note at the top of this file

  // Contact shadow between touching stones. Without it a pile of pebbles reads
  // as a sticker sheet — it is doing most of the work of making the bed look
  // like it has depth, which is why it is worth tuning rather than removing.
  const ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.75, blurRatio: 1 }, [camera]);
  ssao.radius = LOOK.ao.radiusMetres * U;
  ssao.totalStrength = LOOK.ao.strength;
  ssao.base = LOOK.ao.base;
  ssao.samples = LOOK.ao.samples;
  ssao.maxZ = LOOK.ao.maxDistanceMetres * U;
  ssao.expensiveBlur = false; // AUDIT #B6 — see the samples note above

  return {
    ssao,
    toggleAO() {
      ssao.totalStrength = ssao.totalStrength > 0 ? 0 : LOOK.ao.strength;
      return ssao.totalStrength > 0;
    },
  };
}
