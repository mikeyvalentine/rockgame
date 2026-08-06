// Does every module actually get used?
//
// This exists because the same mistake happened three times in one stretch of
// work: a module was written, given a passing test, and then never imported by
// anything that runs. `siftPhysics`, the scene-swap crouch, and the imprint
// layer all sat green in the suite while doing nothing in the app.
//
// Tests do not catch it, and they never will — a unit test imports the module
// itself, so a module with no consumer passes exactly as loudly as one with a
// dozen. From outside, tested-and-unwired is indistinguishable from working.
//
// So the rule is not "everything must be wired". It is "unwired must be
// DECLARED". A module parked deliberately is fine; a module parked by accident
// is the bug. Add the file to UNWIRED with the reason and this passes again —
// and that entry then reads as a to-do list of things built but not connected.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC = join(HERE, "..", "src");
const SHARED = join(ROOT, "shared");

// `shared/` serves every lab, so a module used only by rock-sift or the forge
// is wired — just not from here. Scanning sand-sim alone reported two false
// orphans on the first run, which is a good reminder that "nothing imports it"
// is only true relative to what you looked at.
const OTHER_LABS = ["rock-sift/src", "rock-sift/tools", "rock-forge/src"]
    .map((d) => join(ROOT, d));

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

/**
 * Modules that are deliberately not imported by anything yet, and why.
 *
 * Every entry is work that exists but is not connected. Keep the reasons
 * concrete enough that a stale one is obvious.
 */
const UNWIRED = {
    // Pre-dates this work — it came over with SNOWFLOW for a character
    // skeleton sand-sim does not have yet. Left alone rather than deleted: the
    // reasoning in its header is worth more than the file costs, and the first
    // run of this check finding it is the point.
    "mat4.js":
        "flat-array bone maths for a skeleton the beach has not grown yet",
    "spotImprint.js":
        "built and tested; still needs the bake call when a bed is placed and " +
        "stone contacts fed in while sifting. See docs/09.",
};

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith(".js")) out.push(p);
    }
    return out;
}

// Everything sand-sim could import: its own src, plus the shared modules.
const modules = [...walk(SRC), ...walk(SHARED)];

// Every import specifier anywhere in src, the tools, and the shared modules
// themselves — a module used only by another shared module still counts.
const sources = [...modules, ...walk(HERE)];
for (const d of OTHER_LABS) {
    try { sources.push(...walk(d)); } catch { /* a lab may not be checked out */ }
}
const imported = new Set();
for (const f of sources) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/from\s+"([^"]+\.js)"|import\s+"([^"]+\.js)"/g)) {
        imported.add(basename(m[1] ?? m[2]));
    }
}

// Entry points are imported by index.html or the boot loader, not by a module.
const ENTRY = new Set(["main.js", "webglApp.js", "webgpuApp.js"]);

const orphans = [];
for (const f of modules) {
    const name = basename(f);
    if (ENTRY.has(name) || imported.has(name)) continue;
    orphans.push(name);
}

const undeclared = orphans.filter((n) => !(n in UNWIRED));
check("every module is imported, or declared unwired", undeclared.length === 0,
    undeclared.join(", ") + " — wire it, or add it to UNWIRED with a reason");

// And the reverse: an UNWIRED entry that HAS been wired is a stale note, which
// is how this file would quietly stop meaning anything.
const stale = Object.keys(UNWIRED).filter((n) => imported.has(n));
check("no stale UNWIRED entries", stale.length === 0,
    stale.join(", ") + " — now imported, so drop the entry");

for (const [name, why] of Object.entries(UNWIRED)) {
    if (!imported.has(name)) console.log("     unwired: " + name + " — " + why);
}

process.exit(failures ? 1 : 0);
