// Licence + packaging hygiene — the MIT provenance must survive every edit.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

const license = readFileSync(join(ROOT, "LICENSE"), "utf8");
check("LICENSE is MIT", license.includes("MIT License"));
check("LICENSE keeps the original copyright", license.includes("Maksymilian Dendura"));

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check("package name", pkg.name === "sand-sim");
check("package license MIT", pkg.license === "MIT");
check("ESM", pkg.type === "module");
check("babylon pinned", !!pkg.dependencies?.["@babylonjs/core"]);

const vite = readFileSync(join(ROOT, "vite.config.js"), "utf8");
check("port 5185", vite.includes("5185"));
check("strictPort", vite.includes("strictPort: true"));

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
check("README credits SNOWFLOW", readme.includes("SNOWFLOW"));

process.exit(failures ? 1 : 0);
