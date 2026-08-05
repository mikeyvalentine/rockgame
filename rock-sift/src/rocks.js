// Re-export shim. The rating now lives in shared/rockRating.js, which is canonical.
//
// This file used to hold the implementation, and also used to *generate* rock meshes
// — noise-displaced icospheres, optionally carved by half-spaces for angular stone.
// The generator went first (the scanned stones read better beside it), and the rating
// followed it out, because rock-forge kept a second copy that drifted out of date.
// One file, no copies.
export {
  RARITY_TIERS,
  rarityFor,
  STONE_STAT_TARGETS,
  flatnessScore,
  flatnessFromShape,
  balanceFromMetrics,
  skipRating,
} from "../../shared/rockRating.js";
