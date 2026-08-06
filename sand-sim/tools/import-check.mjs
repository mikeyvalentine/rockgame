// Is every constructor this app calls actually in scope?
//
// This exists because of a specific bug that reached the deployed site: two
// lights were added to `webgpuApp.js` using `new Vector3(...)`, in a module that
// had never needed Vector3 and did not import it. It built cleanly — a bundler
// has no opinion about a free identifier — and it passed every check in the
// suite, because the whole suite tests modules that can run headlessly and
// `webgpuApp` cannot: it needs a WebGPU engine, and there is none here or in
// CI. The first thing to find out was a browser on the live site:
//
//     ReferenceError: Vector3 is not defined
//
// The narrow lesson is that WebGPU-only modules have no runtime coverage at all,
// so anything about them has to be caught statically. The general one is that
// this project keeps being bitten by imports: four Babylon augmentation modules
// so far, three of which failed silently. A missing constructor import is the
// same family and is cheap to rule out.
//
// Deliberately narrow, and that is the point. This is not a linter and should
// not grow into one: it asks one question — is every `new Identifier(` in
// `src/` either imported, declared in the same file, or a JavaScript builtin —
// which is exactly the shape of the bug, with no configuration and no false
// positives to argue about.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

let failures = 0;
const check = (n, ok, d) => { console.log((ok ? "ok   " : "FAIL ") + n + (ok || !d ? "" : " — " + d)); if (!ok) failures++; };

/** Constructors the language provides. Not an allowlist to be topped up lightly. */
const BUILTINS = new Set([
    "Array", "ArrayBuffer", "BigInt64Array", "BigUint64Array", "Blob", "Boolean",
    "DataView", "Date", "Error", "EvalError", "Event", "EventTarget", "File",
    "FileReader", "Float32Array", "Float64Array", "Function", "Image",
    "Int16Array", "Int32Array", "Int8Array", "Intl", "Map", "Number", "Object",
    "Promise", "Proxy", "RangeError", "ReferenceError", "RegExp", "Set",
    "SharedArrayBuffer", "String", "SyntaxError", "TextDecoder", "TextEncoder",
    "TypeError", "URIError", "URL", "URLSearchParams", "Uint16Array",
    "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef",
    "WeakSet", "Worker", "XMLHttpRequest",
]);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith(".js")) out.push(p);
    }
    return out;
}

/**
 * Names a module brings into its own scope.
 *
 * Import forms, then anything declared at any depth — a constructor defined in
 * a nested block is still not the bug being hunted, and treating the file as
 * one flat scope keeps this from needing a parser.
 */
function scopeOf(src) {
    const names = new Set();

    // import { A, B as C } from "..."   /   import D, { E } from "..."   /
    // import * as F from "..."
    for (const m of src.matchAll(/^\s*import\s+([^;]+?)\s+from\s+["'][^"']+["']/gm)) {
        const clause = m[1];
        for (const g of clause.matchAll(/\{([^}]*)\}/g)) {
            for (const part of g[1].split(",")) {
                const bits = part.trim().split(/\s+as\s+/);
                const local = (bits[1] ?? bits[0]).trim();
                if (local) names.add(local);
            }
        }
        const bare = clause.replace(/\{[^}]*\}/g, "").replace(/\*\s+as\s+/g, "");
        for (const part of bare.split(",")) {
            const local = part.trim();
            if (local && /^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
        }
    }

    for (const m of src.matchAll(/\b(?:class|function)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

    // Destructured bindings, including the nested ones a dynamic import
    // produces: `const [{ HavokPlugin }, { default: X }] = await Promise.all(…)`.
    // Inside a pattern, a name followed by `:` is the KEY and the name after it
    // is the binding — taking both would make this check quietly permissive.
    for (const m of src.matchAll(/\b(?:const|let|var)\s*([[{])/g)) {
        const open = m[1];
        const close = open === "[" ? "]" : "}";
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < src.length; i++) {
            if (src[i] === open || (open === "[" && src[i] === "{") || (open === "{" && src[i] === "[")) depth++;
            else if (src[i] === close || (open === "[" && src[i] === "}") || (open === "{" && src[i] === "]")) {
                depth--;
                if (depth === 0) break;
            }
        }
        const pattern = src.slice(m.index, i + 1);
        for (const id of pattern.matchAll(/([A-Za-z_$][\w$]*)\s*(:)?/g)) {
            if (id[2]) continue;                       // a key, not a binding
            if (["const", "let", "var"].includes(id[1])) continue;
            names.add(id[1]);
        }
    }
    return names;
}

/** Strip comments and strings, so a `new Foo(` inside either is not a use. */
function code(src) {
    // Newlines are preserved through every removal, so a reported line number
    // still points at the line in the real file. A blanked-out block comment
    // that swallowed its own newlines would report the bug several lines above
    // where it is, which is worse than not reporting a line at all.
    const blank = (s) => s.replace(/[^\n]/g, " ");
    return src
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)))
        .replace(/`(?:\\[\s\S]|[^\\`])*`/g, blank)
        .replace(/"(?:\\.|[^\\"])*"/g, '""')
        .replace(/'(?:\\.|[^\\'])*'/g, "''");
}

const files = walk(SRC);
check("there are modules to check", files.length > 0, files.length + " files");

const missing = [];
for (const file of files) {
    const src = readFileSync(file, "utf8");
    const body = code(src);
    const scope = scopeOf(src);

    for (const m of body.matchAll(/\bnew\s+([A-Z][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (scope.has(name) || BUILTINS.has(name)) continue;
        // Which line, so the failure names a place rather than a file.
        const line = body.slice(0, m.index).split("\n").length;
        missing.push(`${file.slice(SRC.length)}:${line} new ${name}()`);
    }
}

check("every constructor used is imported or declared", missing.length === 0,
    missing.join("; "));

// The specific one, pinned by name. The lights are the only reason webgpuApp
// touches Vector3, and a future tidy that drops the lights should drop this
// with them rather than leave a check passing for the wrong reason.
const webgpu = readFileSync(join(SRC, "app", "webgpuApp.js"), "utf8");
const usesVector3 = /new\s+Vector3\s*\(/.test(webgpu);
check("webgpuApp imports Vector3 if it uses it",
    !usesVector3 || /import\s*\{[^}]*\bVector3\b[^}]*\}\s*from\s*["']@babylonjs/.test(webgpu));

// And the lights themselves, since a scene with none is the other half of why
// the stones rendered black. This one cannot be caught at runtime either.
check("the WebGPU scene has lights for the PBR stones",
    /new\s+DirectionalLight\s*\(/.test(webgpu) && /new\s+HemisphericLight\s*\(/.test(webgpu),
    "PBR meshes in a scene with no lights render black");

process.exit(failures ? 1 : 0);
