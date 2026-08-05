/**
 * Central tuning + toggle store.
 *
 * `S` is a flat plain object read directly by systems every frame — no getters,
 * no proxies, no allocation. `SCHEMA` is metadata the settings overlay builds
 * its widgets from, and `onChange` lets systems react to edits that need work
 * (rebuilding a render target, re-freezing a material) rather than just being
 * sampled next frame.
 */

/** @type {Record<string, number|boolean|string>} */
export const S = {
    // ---------------------------------------------------------------- quality
    preset: "ultra",
    resolutionScale: 1.0,

    // ------------------------------------------------------------------- sun
    // Azimuth/elevation are seeded at load from the HDRI's own brightest texel
    // (see environment.js `_findSun`), so these initial values only matter for
    // the first frames of the solve. Moving the sliders afterwards desyncs the
    // light from the baked sun disc — deliberately kept as a debug axis.
    sunAzimuth: 320,
    sunElevation: 45,
    sunIntensity: 4.2,
    ambientIntensity: 1.0,

    // ------------------------------------------------------------- atmosphere
    fogDensity: 0.0072,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 1.0,
    // Degrees. Drives sastrugi shear and dune orientation. Held 70-80 degrees
    // away from `sunAzimuth`: sastrugi ridges run along the wind, so when the
    // two align the sun rakes down every ridge, lights both flanks identically
    // and the fine structure reads as flat ground.
    windDirection: 42,
    windStrength: 1.0,
    /** Strength of the volumetric shafts spilling past crests. */
    shaftStrength: 0.30,

    // ------------------------------------------------------------------- sand
    // Quartz sparkle, not snow glitter — a fifth of the snow default.
    glintIntensity: 0.12,
    glintGrazing: 0.6, // how hard the grazing-angle gate bites
    // Sand is nearly opaque; what survives is a faint warm rim on thin edges.
    sssStrength: 0.15,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 2048,

    // ------------------------------------------------------------ mask brush
    // Debug paint tool for the material masks. Active while the pointer is
    // unlocked (overlay open); clicking the canvas paints instead of locking.
    maskBrushMode: "off", // off | pebble+ | pebble- | wet+ | wet-
    maskBrushRadius: 1.5,
    maskBrushStrength: 0.5,

    // ---------------------------------------------------------------- grains
    /**
     * Live-grain budget for the hybrid layer. A hard cap the spawners respect;
     * 0 turns the layer off entirely (the sim never depends on it).
     */
    grainBudget: 2048,

    // ------------------------------------------------------------------ post
    taa: true,
    // Off by default for sand: the SSR pass reconstructs normals from the
    // depth buffer, which is per-facet on carved geometry — on a wet dig
    // crater (wetness arms its gate) it renders as shattered-glass panes.
    // The intended barely-there wet sheen isn't worth that; toggle to compare.
    ssr: false,
    dof: true,
    bloom: true,
    grain: true,
    sharpen: true,
    tonemap: "agx", // "agx" | "aces" | "none"
    // The analytic sky's 0.105 was measured against Nishita-scale radiance
    // (sunlit snow ~12 linear). The HDRI regime runs darker — sky radiance is
    // O(1) — so the default moves up. First candidate for retuning by eye.
    exposure: 0.35,
    contrast: 1.14,
    bloomStrength: 0.22,
    grainStrength: 0.022,
    sharpenStrength: 0.55,

    // --------------------------------------------------------------- systems
    showTerrain: true,
    showLightShafts: true,
    wireframe: false,
    freezeTime: false,
    /**
     * The pausable-sim gate: the deformation pass only dispatches while
     * something disturbs the sand. Off = step every frame (for A/B-ing the
     * gate's cost on the overlay's GPU row).
     */
    simGate: true,

    // ----------------------------------------------------------------- debug
    debugView: "beauty", // beauty | deform | normals | depth | cascades | footprint | fineNormals
};

/**
 * Widget metadata. `t`: "f" float slider, "b" bool toggle, "e" enum.
 * @type {{group:string, items:Array<{k:string,l:string,t:string,min?:number,max?:number,step?:number,opts?:string[]}>}[]}
 */
export const SCHEMA = [
    {
        group: "Sun & Sky",
        items: [
            // Azimuth/elevation are debug axes: they move the *light*, not the
            // baked HDRI sun disc. Seeded from the HDRI at load.
            { k: "sunAzimuth", l: "Az (debug)", t: "f", min: 0, max: 360, step: 1 },
            { k: "sunElevation", l: "El (debug)", t: "f", min: 0.5, max: 89, step: 0.1 },
            { k: "sunIntensity", l: "Intensity", t: "f", min: 0, max: 10, step: 0.05 },
            { k: "ambientIntensity", l: "Ambient", t: "f", min: 0, max: 3, step: 0.01 },
        ],
    },
    {
        group: "Atmosphere",
        items: [
            { k: "fogDensity", l: "Fog density", t: "f", min: 0, max: 0.03, step: 0.0001 },
            { k: "fogHeightFalloff", l: "Height falloff", t: "f", min: 0, max: 0.3, step: 0.001 },
            { k: "aerialStrength", l: "Aerial persp.", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "windDirection", l: "Wind dir", t: "f", min: 0, max: 360, step: 1 },
            { k: "windStrength", l: "Wind strength", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showLightShafts", l: "Light shafts", t: "b" },
            { k: "shaftStrength", l: "Shaft amt", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Sand",
        items: [
            { k: "glintIntensity", l: "Sparkle", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "glintGrazing", l: "Sparkle gate", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sssStrength", l: "Rim scatter", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "sssRadius", l: "Scatter radius", t: "f", min: 0.1, max: 3, step: 0.01 },
            { k: "detailNormalStrength", l: "Detail normals", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "macroHeightScale", l: "Relief", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "sastrugiStrength", l: "Wind ridges", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Deformation",
        items: [
            { k: "deformDepth", l: "Depth", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "deformBerm", l: "Berm mass", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "refillRate", l: "Heal rate", t: "f", min: 0, max: 4, step: 0.01 },
        ],
    },
    {
        group: "Mask brush",
        items: [
            {
                k: "maskBrushMode", l: "Mode", t: "e",
                opts: ["off", "pebble+", "pebble-", "wet+", "wet-"],
            },
            { k: "maskBrushRadius", l: "Radius", t: "f", min: 0.25, max: 6, step: 0.05 },
            { k: "maskBrushStrength", l: "Strength", t: "f", min: 0.05, max: 1, step: 0.05 },
        ],
    },
    {
        group: "Grains",
        items: [
            { k: "grainBudget", l: "Budget", t: "f", min: 0, max: 5120, step: 64 },
        ],
    },
    {
        group: "Post",
        items: [
            { k: "taa", l: "TAA", t: "b" },
            { k: "ssr", l: "SSR (ice)", t: "b" },
            { k: "dof", l: "Depth of field", t: "b" },
            { k: "bloom", l: "Bloom", t: "b" },
            { k: "grain", l: "Film grain", t: "b" },
            { k: "sharpen", l: "Sharpen", t: "b" },
            { k: "tonemap", l: "Tonemap", t: "e", opts: ["agx", "aces", "none"] },
            { k: "exposure", l: "Exposure", t: "f", min: 0.01, max: 0.6, step: 0.005 },
            { k: "contrast", l: "Contrast", t: "f", min: 0.5, max: 2, step: 0.01 },
            { k: "bloomStrength", l: "Bloom amt", t: "f", min: 0, max: 1, step: 0.005 },
            { k: "grainStrength", l: "Grain amt", t: "f", min: 0, max: 0.1, step: 0.001 },
            { k: "sharpenStrength", l: "Sharpen amt", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
    {
        group: "Systems",
        items: [
            { k: "showTerrain", l: "Terrain", t: "b" },
            { k: "simGate", l: "Sim gate", t: "b" },
            { k: "wireframe", l: "Wireframe", t: "b" },
            { k: "freezeTime", l: "Freeze time", t: "b" },
            { k: "resolutionScale", l: "Resolution", t: "f", min: 0.5, max: 1.5, step: 0.05 },
            {
                k: "debugView", l: "Debug view", t: "e",
                opts: ["beauty", "deform", "normals", "depth", "cascades", "footprint",
                       "fineNormals", "shadow", "ndotl", "shadowMap", "albedo"],
            },
        ],
    },
];

/** Quality presets. Only the keys that differ from `ultra` need listing. */
export const PRESETS = {
    ultra: {},
    high: { deformResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true },
    balanced: {
        deformResolution: 1024, resolutionScale: 0.85,
        ssr: false, dof: false,
    },
};

/** @type {Map<string, Set<(v:any, k:string) => void>>} */
const listeners = new Map();

/**
 * Subscribe to a settings key. Returns an unsubscribe function.
 * @param {string|string[]} keys
 * @param {(v:any, k:string) => void} fn
 */
export function onChange(keys, fn) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (let i = 0; i < list.length; i++) {
        let set = listeners.get(list[i]);
        if (!set) {
            set = new Set();
            listeners.set(list[i], set);
        }
        set.add(fn);
    }
    return () => {
        for (let i = 0; i < list.length; i++) listeners.get(list[i])?.delete(fn);
    };
}

/**
 * Write a settings value and notify subscribers. Never called from the render
 * loop — only from the overlay and preset application.
 * @param {string} k
 * @param {number|boolean|string} v
 */
export function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    const set_ = listeners.get(k);
    if (set_) for (const fn of set_) fn(v, k);
}

/** @param {keyof typeof PRESETS} name */
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    S.preset = name;
    for (const k in p) set(k, p[k]);
}
