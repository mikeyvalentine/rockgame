// Real rock surfaces, loaded from public/assets/rock/manifest.json.
//
// Choosing these is not a matter of taste, and two traps are worth stating
// because both are invisible until the whole field is built:
//
//   Scale. A texture showing *many* rocks, mapped onto *one* rock, puts tiny
//   rocks inside a rock. That rules out everything in `scan/` (which is also
//   UV-mapped to a specific mesh and does not tile), plus gravel_rubble,
//   rock_beach_small_002 and muddy_rubble_slope. Only "the surface of a single
//   rock" textures are usable.
//
//   Atlases. A texture can tile cleanly at its edges and still be unusable: a
//   bake of a *single mesh* is an island of surface surrounded by radial edge
//   padding, and tiled triplanar that padding reads as a fan of streaks across
//   every stone. Seam error cannot see it — pebble_scan passed at 2.16 — so
//   texture-check also measures structure-tensor coherence, on which padding
//   scores 0.49 against 0.11-0.21 for a real surface.
//
//   Relief. Several sets ship a normal map that is nearly flat — measured as
//   mean angular deviation from (128,128,255), marble_rock_02 is 5.0 degrees
//   and rock_046_craggy is 3.3, against 21.7 for rock_027. A flat normal map
//   gives you back the smooth primitive you were trying to get rid of, so the
//   assignments below are ordered by that measurement, not by name.
//
// tools/texture-check.py re-runs both measurements over the whole set.

import { Constants, Texture } from "@babylonjs/core";

/**
 * Per-archetype surface. Picked for measured normal detail first, then for
 * luminance and saturation matching the lithology.
 *   nrm = mean normal deviation in degrees, lum = mean albedo luminance 0-255
 */
export const SURFACES = {
  granite:   { material: "rock_027",            repeat: 0.42 }, // nrm 21.7, lum 151, neutral, 2K, full channels
  sandstone: { material: "rough_rock_012",      repeat: 0.46 }, // nrm 14.8, lum 137, warm — and it brings an AO map, which rock_04 lacked
  quartz:    { material: "marble_col_001",      repeat: 0.50 }, // nrm 10.7, lum 127 — marble, which is what a quartz pebble is
  basalt:    { material: "rough_rock_015",      repeat: 0.44 }, // nrm 23.0, lum  79 — the strongest relief in the set
  slate:     { material: "quarry_wall_02",      repeat: 0.38 }, // nrm 12.2, lum  75, dark, quarried bedding
  flint:     { material: "granite_002",         repeat: 0.42 }, // colour only, lum 62 — the darkest neutral; flint is glassy so low relief suits it
  chert:     { material: "pebble_scan",         repeat: 0.34 }, // colour only, lum 84 — the one warm-dark surface. See the manifest note.
};

/**
 * Shared height map driving real vertex displacement.
 *
 * rough_rock_015 beats the previous pick on every count: a 5th-to-95th range of
 * 221 against cliff_jagged_004's 153, seamless at 1.09, and *square* — the old
 * one was 2048x898, which needed the aspect correction below to stop triplanar
 * smearing it 2.28:1 into something that looked like brushed metal.
 *
 * The rejects are worth recording. rock_027's displacement covers 30 levels and
 * Granite_002's covers 3 — both effectively flat. The four 16-bit PNGs
 * (rock_ground, rock_mossy_2, gravel_rubble, muddy_rubble_slope) are all "field
 * of rubble" textures, so they are the wrong scale for a single pebble whatever
 * their range.
 */
export const HEIGHT_SOURCE = { class: "tileable", material: "rough_rock_015", map: "height" };

function makeTexture(scene, url, { srgb }) {
  const tex = new Texture(url, scene, /* noMipmap */ false, /* invertY */ false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  // Colour is authored in sRGB; normal, AO, roughness and height are data and
  // must not be gamma-decoded or every one of them shifts.
  tex.gammaSpace = srgb;
  return tex;
}

const whenReady = (tex) => new Promise((res) => {
  if (tex.isReady()) return res(tex);
  tex.onLoadObservable.addOnce(() => res(tex));
});

/**
 * @returns {{ perArchetype: Record<string, object>, height: Texture|null, bytes: number, notes: string[] }}
 */
export async function loadRockTextures(scene, { manifestUrl = "/assets/rock/manifest.json" } = {}) {
  const manifest = await fetch(manifestUrl).then((r) => {
    if (!r.ok) throw new Error(`${manifestUrl} -> ${r.status}`);
    return r.json();
  });

  const find = (name) => {
    for (const cls of Object.keys(manifest)) {
      if (manifest[cls][name]) return manifest[cls][name];
    }
    return null;
  };

  const notes = [];
  let bytes = 0;
  const pending = [];
  const perArchetype = {};

  for (const [archetype, pick] of Object.entries(SURFACES)) {
    const entry = find(pick.material);
    if (!entry) { notes.push(`${archetype}: "${pick.material}" not in manifest`); continue; }

    const url = (file) => `/${entry.path}/${file}`;
    const m = entry.maps;
    const px = entry.size[0] * entry.size[1];

    const set = { material: pick.material, repeat: pick.repeat, size: entry.size };

    set.colour = makeTexture(scene, url(m.color), { srgb: true });
    bytes += px * 4;

    if (m.normal) {
      set.normal = makeTexture(scene, url(m.normal), { srgb: false });
      bytes += px * 4;
    } else {
      notes.push(`${archetype}: "${pick.material}" has no normal map — falling back to procedural grain`);
    }

    // `arm` packs AO/rough/metal into R/G/B; a plain `rough` map is greyscale.
    // Only the AO channel is used here: PBR resolves roughness after the hook
    // this plugin writes into, so per-texel roughness would have no effect.
    if (m.arm) {
      set.surf = makeTexture(scene, url(m.arm), { srgb: false });
      set.aoChannel = "r";
      bytes += px * 4;
    } else if (m.ao) {
      set.surf = makeTexture(scene, url(m.ao), { srgb: false });
      set.aoChannel = "r";
      bytes += px * 4;
    }

    perArchetype[archetype] = set;
    pending.push(...[set.colour, set.normal, set.surf].filter(Boolean).map(whenReady));
  }

  let height = null;
  // cliff_jagged_004 is 2048x898. Triplanar sampling gives every plane the same
  // UV scale, so a non-square source comes out smeared 2.28:1 along one axis —
  // directional streaking that reads as brushed metal, not rock. The shader
  // divides the second coordinate by this to keep texels square.
  let heightAspect = 1;
  let heightWidth = 1024;
  const hEntry = manifest[HEIGHT_SOURCE.class]?.[HEIGHT_SOURCE.material];
  if (hEntry?.maps?.[HEIGHT_SOURCE.map]) {
    height = makeTexture(scene, `/${hEntry.path}/${hEntry.maps[HEIGHT_SOURCE.map]}`, { srgb: false });
    heightAspect = hEntry.size[1] / hEntry.size[0];
    heightWidth = hEntry.size[0];
    bytes += hEntry.size[0] * hEntry.size[1] * 4;
    pending.push(whenReady(height));
  } else {
    notes.push(`height source "${HEIGHT_SOURCE.material}" missing — no vertex displacement`);
  }

  await Promise.all(pending);
  // Mip chains add a third again on top of the base level.
  return { perArchetype, height, heightAspect, heightWidth, bytes: Math.round(bytes * 4 / 3), notes };
}
