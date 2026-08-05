// One set of scribble/pastel dials, shared by every lab page.
//
// THE MECHANISM: settings live in a cookie on `localhost` (mirrored to
// localStorage as a fallback). Browsers scope cookies by host, NOT by port —
// so the hub on :5180, rock-sift on :5183, rock-forge on :5184 and sand-sim on
// :5185 all read the same jar. That is the whole trick behind "dial it in on
// one page, walk to another, same look".
//
// THE CONTRACT: only keys the user has actually touched are stored, and only
// stored keys are applied. Each lab keeps its own tuned baseline (rock-sift's
// exposure 1.05, sand-sim's own tonemap, the water sim's warmth 28) until a
// dial is moved — then that one value carries everywhere it applies. "Reset"
// clears the store, handing every lab back its own defaults.
//
// Two ways in:
//   attachScribblePanel({ apply, get, supports }) — the floating dial panel,
//     for labs that have no scribble controls of their own.
//   loadScribbleSettings() / watchAndSave(container, harvest) — for labs that
//     already have panels (babylon-water, rock-forge): apply the store at
//     boot, harvest their own dials into it on change.

const COOKIE = "rockgame_scribble";
const LS_KEY = "rockgame_scribble";

// key → [label, min, max, step, default, group]. The defaults are the user's
// dialled-in universal look (2026-08-04), which superseded the water sim's
// original dump values — change them here AND in the per-lab defaults
// (shared/scribble-fx.js, sand-sim scribblePass.js, rock-forge state +
// scribbleEnv.js, babylon-water inline + portable) or labs drift.
export const SCRIBBLE_PARAMS = {
  on:            ["pastel on",      0, 1, 1,        1,      "pastel"],
  levels:        ["value steps",    2, 64, 1,       30,     "pastel"],
  satAmount:     ["saturation",     0, 1.4, 0.02,   1.02,   "pastel"],
  strokeAmount:  ["stroke amount",  0, 1, 0.02,     0.02,   "pastel"],
  strokeFreq:    ["stroke density", 4, 140, 2,      10,     "pastel"],
  strokeAngle:   ["stroke angle",   0, 3.14, 0.05,  0.5,    "pastel"],
  paperScale:    ["paper scale",    0.5, 40, 0.25,  37.25,  "pastel"],
  grain:         ["paper grain",    0, 0.8, 0.02,   0.14,   "pastel"],
  bleed:         ["colour bleed",   0, 0.03, 0.001, 0,      "pastel"],
  warp:          ["paper warp",     0, 0.02, 0.001, 0,      "pastel"],
  ignoreSky:     ["ignore sky",     0, 1, 1,        1,      "pastel"],
  skyDepth:      ["sky depth",      0.9, 0.9999, 0.0005, 0.999, "pastel"],
  exposure:      ["exposure",       0.2, 3, 0.01,   1.0,    "look"],
  warmth:        ["warmth",         -100, 100, 1,   28,     "look"],
  warmthHue:     ["warmth hue",     0, 360, 1,      30,     "look"],
  envSaturation: ["env saturation", -100, 100, 1,   6,      "look"],
};

export const PASTEL_KEYS = Object.keys(SCRIBBLE_PARAMS).filter((k) => SCRIBBLE_PARAMS[k][5] === "pastel");
export const LOOK_KEYS = Object.keys(SCRIBBLE_PARAMS).filter((k) => SCRIBBLE_PARAMS[k][5] === "look");

// ------------------------------------------------------------------- storage

function readRaw() {
  try {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]*)"));
    if (m) return JSON.parse(decodeURIComponent(m[1]));
  } catch { /* fall through to localStorage */ }
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) return JSON.parse(s);
  } catch { /* no storage at all */ }
  return {};
}

function writeRaw(obj) {
  const json = JSON.stringify(obj);
  try {
    document.cookie = COOKIE + "=" + encodeURIComponent(json) +
      "; path=/; max-age=31536000; SameSite=Lax";
  } catch { /* cookie jar closed */ }
  try { localStorage.setItem(LS_KEY, json); } catch { /* fine */ }
}

/** Only keys the user has touched. May be empty — that means "every lab on its
 *  own defaults". */
export function loadScribbleSettings() {
  const raw = readRaw();
  const out = {};
  for (const k of Object.keys(SCRIBBLE_PARAMS)) if (k in raw) out[k] = raw[k];
  return out;
}

export function saveScribbleSettings(patch) {
  writeRaw({ ...readRaw(), ...patch });
}

export function clearScribbleSettings() {
  writeRaw({});
}

export function defaultOf(key) { return SCRIBBLE_PARAMS[key][4]; }

// -------------------------------------------------------- panel-less syncing

/**
 * For labs with their own dials. Listens for input/change anywhere under
 * `container`, waits a beat, then asks `harvest()` for the lab's current
 * values (an object of SCRIBBLE_PARAMS keys) and stores them. Storing on ANY
 * panel event rather than wiring each slider keeps the lab's own code intact.
 */
export function watchAndSave(container, harvest) {
  let t = null;
  const kick = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try { saveScribbleSettings(harvest()); } catch (e) { console.warn("[scribble] harvest failed", e); }
    }, 200);
  };
  container.addEventListener("input", kick);
  container.addEventListener("change", kick);
}

// ---------------------------------------------------------------- the panel

const CSS = `
.scrib-panel { position: fixed; left: 12px; bottom: 12px; z-index: 9999;
  font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace; color: #dceaf5; }
.scrib-toggle { padding: 6px 12px; cursor: pointer; color: #eaf4fb;
  background: #1b3346d9; border: 1px solid #4d7a99; border-radius: 6px; font: inherit; }
.scrib-toggle:hover { background: #27506e; }
.scrib-body { display: none; width: 236px; max-height: min(70vh, 560px); overflow-y: auto;
  margin-bottom: 8px; padding: 10px 12px 12px; background: #0d1c2aee;
  border: 1px solid #2f5570; border-radius: 7px; }
.scrib-panel.open .scrib-body { display: block; }
.scrib-body h4 { margin: 10px 0 6px; font-size: 10px; letter-spacing: .09em;
  text-transform: uppercase; color: #7fb4d6; font-weight: 600; }
.scrib-body h4:first-child { margin-top: 0; }
.scrib-row { margin-bottom: 7px; }
.scrib-lab { display: flex; justify-content: space-between; gap: 8px; }
.scrib-lab span:last-child { color: #fff; }
.scrib-row input[type=range] { width: 100%; margin: 2px 0 0; height: 14px; }
.scrib-reset { width: 100%; margin-top: 8px; padding: 6px 0; font: inherit; cursor: pointer;
  color: #9fb3c8; background: #1d2836; border: 1px solid #2f5570; border-radius: 5px; }
.scrib-reset:hover { background: #26364a; }
.scrib-note { margin: 8px 0 0; color: #7d8fa3; font-size: 10px; }
`;

/**
 * The universal dial panel.
 *
 * @param {object}   o
 * @param {Function} o.apply    (key, value, allSettings) → push one value into
 *                              the lab's scene. Called for every stored key at
 *                              attach time, then per change.
 * @param {Function} [o.get]    (key) → the lab's CURRENT value, used to seat
 *                              sliders that have no stored value yet.
 * @param {string[]} [o.supports] keys to show (default: all).
 * @param {string}   [o.note]   one-liner shown at the bottom.
 */
export function attachScribblePanel({ apply, get, supports, note } = {}) {
  const keys = supports || Object.keys(SCRIBBLE_PARAMS);
  const stored = loadScribbleSettings();

  // Push what the user has dialled in before building any UI.
  for (const k of keys) if (k in stored) safeApply(k, stored[k]);
  function safeApply(k, v) {
    try { apply(k, v, loadScribbleSettings()); }
    catch (e) { console.warn("[scribble] apply failed:", k, e); }
  }

  if (!document.getElementById("scrib-style")) {
    const style = document.createElement("style");
    style.id = "scrib-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement("div");
  root.className = "scrib-panel";
  const body = document.createElement("div");
  body.className = "scrib-body";
  const toggle = document.createElement("button");
  toggle.className = "scrib-toggle";
  toggle.textContent = "✏ scribble";
  toggle.addEventListener("click", () => root.classList.toggle("open"));
  root.append(body, toggle);

  const rows = {};
  let group = null;
  for (const key of keys) {
    const [label, min, max, step, dflt, grp] = SCRIBBLE_PARAMS[key];
    if (grp !== group) {
      group = grp;
      const h = document.createElement("h4");
      h.textContent = grp === "pastel" ? "pastel pass" : "look / env grade";
      body.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "scrib-row";
    const lab = document.createElement("div");
    lab.className = "scrib-lab";
    const name = document.createElement("span");
    name.textContent = label;
    const val = document.createElement("span");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = min; slider.max = max; slider.step = step;

    const current = key in stored ? stored[key]
      : (get ? numberOr(get(key), dflt) : dflt);
    slider.value = current;
    val.textContent = fmt(current, step);

    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      val.textContent = fmt(v, step);
      saveScribbleSettings({ [key]: v });
      safeApply(key, v);
    });

    lab.append(name, val);
    row.append(lab, slider);
    body.appendChild(row);
    rows[key] = { slider, val };
  }

  const reset = document.createElement("button");
  reset.className = "scrib-reset";
  reset.textContent = "reset — every lab back to its own defaults";
  reset.addEventListener("click", () => {
    clearScribbleSettings();
    for (const key of keys) {
      const dflt = defaultOf(key);
      rows[key].slider.value = dflt;
      rows[key].val.textContent = fmt(dflt, SCRIBBLE_PARAMS[key][3]);
      safeApply(key, dflt);
    }
  });
  body.appendChild(reset);

  const p = document.createElement("p");
  p.className = "scrib-note";
  p.textContent = note || "Carries across every lab page (localhost cookie, ports ignored).";
  body.appendChild(p);

  document.body.appendChild(root);
  return { root, rows };
}

function numberOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmt(v, step) {
  const dec = step >= 1 ? 0 : step >= 0.01 ? 2 : 3;
  return Number(v).toFixed(dec);
}
