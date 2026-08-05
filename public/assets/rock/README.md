# Rock texture sample set

45 rock/stone materials pulled from `D:\Textures` and `~\Downloads` for use in rock-forge.
Everything here is verified non-blank and normalized to `<material>_<channel>.<ext>`.

Load via `manifest.json`:

```js
const lib = await fetch('/assets/rock/manifest.json').then(r => r.json())
const m = lib.tileable.rock_face          // { path, size, maps }
new Texture(`/${m.path}/${m.maps.color}`, scene)
```

## Categories

| folder | count | what it is |
| --- | --- | --- |
| `tileable/` | 25 | seamless PBR surfaces, 1K (one 4K). Best for shell/detail texturing. |
| `displacement/` | 7 | sets that carry a real height map — usable to drive geometry, not just shading. |
| `scan/` | 13 | photogrammetry rock albedo/normal. **Not seamless** — UV-mapped to a specific mesh. |

## Channels

`color` `normal` `rough` `ao` `height` `arm` `metalrough` `gloss` `color_var2`

- `arm` is packed **A**O / **R**ough / **M**etal in R/G/B — split it in-shader, don't feed it as albedo.
- `metalrough` is glTF convention: roughness in G, metalness in B.
- `gloss` (cliff_jagged_004 only) is *inverse* roughness — invert before use.
- All normals are OpenGL-convention (+Y up). Babylon wants this as-is.

## Height maps — read before using

`displacement/` height maps are **16-bit** where the source was 16-bit:

- `rock_mossy_2`, `rock_ground`, `gravel_rubble`, `muddy_rubble_slope` — 16-bit PNG (`I;16`).
  Do not run these through an 8-bit path; a naive `convert("L")` clips them to garbage.
- `rock_046_craggy` — 8-bit PNG, range 33–212 (already normalized).
- `cliff_jagged_004`, `rock_beach_small_002` — 8-bit JPG from 8-bit sources.

Browsers decode 16-bit PNG down to 8 bits per channel. If you need the full range on the
GPU, re-export those four to a 16-bit-safe format (EXR / two-channel encoded PNG) rather
than reading them through `<img>`.

## Known gaps

- `granite_red_001` ships **color + rough only**. The normal, AO and height files in the
  master library (`D:\Textures\red marble\`) are blank placeholders — flat 128/127/255
  normal, pure-white AO, constant height — so they were dropped rather than copied.
- `river_stones`, `scanned_rocks` (color), `river_stones` have no normal map.
- `rock_027` was 4K PNG (~90 MB); color and normal are downscaled to 2K JPG here. The
  original is at `D:\Textures\rock mat\Rock_027_*.png`.
- `rock_beach_small_002` is downscaled from 4K. Original 4K set:
  `D:\Textures\Charlie Textures]\Textures\RockBeachSmall002\`.

## Sources

`D:\Textures\rock mat\` · `craggy stone\` · `red marble\` · `obj\` ·
`Charlie Textures]\Textures\{CliffJagged004, RockBeachSmall002, Rock Ground, Rubble, Muddy Rubble Slope, ForestFloor Mossy}\`

Nine sets originated in `~\Downloads` and were filed into `D:\Textures\obj\` first — see
`D:\Textures\obj\_ADDED.md`.
