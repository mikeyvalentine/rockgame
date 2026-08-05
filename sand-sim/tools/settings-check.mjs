// Settings ↔ SCHEMA ↔ consumers integrity — the risk-#9 drift detector.
//
// Dead S keys and SCHEMA rows pointing at nothing fail silently in the app
// (a slider that moves nothing); here they fail loudly.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { S, SCHEMA, PRESETS } from "../src/core/settings.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".js")) out.push(p);
    }
    return out;
}

// ---- every SCHEMA row points at a real key, with a legal default ------------
const badRows = [];
for (const group of SCHEMA) {
    for (const it of group.items) {
        if (!(it.k in S)) badRows.push(group.group + "/" + it.k);
        else if (it.t === "e" && !it.opts.includes(String(S[it.k]))) {
            badRows.push(group.group + "/" + it.k + " default '" + S[it.k] + "' not in opts");
        }
    }
}
check("SCHEMA rows point at real keys", badRows.length === 0, badRows.join(", "));

// ---- every preset override targets a real key -------------------------------
const badPreset = [];
for (const name in PRESETS) {
    for (const k in PRESETS[name]) if (!(k in S)) badPreset.push(name + "/" + k);
}
check("presets target real keys", badPreset.length === 0, badPreset.join(", "));

// ---- every S key is consumed somewhere --------------------------------------
const srcText = walk(join(ROOT, "src"))
    .filter((p) => !p.endsWith("settings.js"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
// A key is consumed either by direct read (`S.key`) or by subscription
// (`onChange("key", …)`) — both are real consumers.
const consumed = (k) =>
    srcText.includes("S." + k) || srcText.includes('onChange("' + k + '"');

const dead = [];
for (const k of Object.keys(S)) {
    const inSchema = SCHEMA.some((g) => g.items.some((it) => it.k === k));
    if (!consumed(k) && !inSchema) dead.push(k);
}
check("no dead settings keys", dead.length === 0, dead.join(", "));

// SCHEMA-only keys (a slider that no system reads) are worth a loud list too.
const schemaOnly = [];
for (const g of SCHEMA) {
    for (const it of g.items) {
        if (!consumed(it.k)) schemaOnly.push(it.k);
    }
}
check("every slider is read by a system", schemaOnly.length === 0, schemaOnly.join(", "));

process.exit(failures ? 1 : 0);
