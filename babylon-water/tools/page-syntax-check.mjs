// node babylon-water/tools/page-syntax-check.mjs   (part of `npm test`)
//
// Does every script block in the skip lab actually PARSE?
//
// ## Why this is worth a file
//
// babylon-water/index.html is ~2,900 lines of inline JavaScript with no build
// step. Nothing between writing it and a browser running it — no bundler, no
// type checker, no linter — so a syntax error ships silently: the page loads,
// the classic script dies on the first token it cannot read, and what you get
// is a blank canvas and `SKIP is not defined` from the module that ran fine.
// Every test in the repo still passes, because they all parse constants out of
// the file as TEXT.
//
// ## The bug that prompted it
//
// The shaders are template literals. A comment written INSIDE one:
//
//     // Evan's normal pass treats a UV step as the run, so `simSlope` is ...
//
// closes the template at the first backtick. The rest of the shader becomes
// JavaScript, and the file stops parsing 2,000 lines from where the mistake is.
// Markdown habits and template literals do not mix, and the failure is
// invisible to every text-matching check in the suite.
//
// ## What it does NOT do
//
// This is `node --check`, not execution: it catches syntax, not references to
// browser globals, and it says nothing about whether the GLSL inside those
// templates compiles. Cheap, and it covers the whole class of error that costs
// a whole page.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pages made of inline script, with no build step to catch this for them. */
const PAGES = ["../index.html"];

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "page-syntax-"));

for (const page of PAGES) {
  const url = new URL(page, import.meta.url);
  const html = readFileSync(fileURLToPath(url), "utf8");

  // Modules and classic scripts parse under different rules (import/export are
  // only legal in one), so each block is checked as what the browser will treat
  // it as. The extension is what tells `node --check` which to use.
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attrs, body], i) => ({
      i,
      module: /type\s*=\s*["']module["']/.test(attrs),
      body,
    }))
    .filter((b) => b.body.trim().length);

  check(`${page} has inline script to check`, blocks.length > 0,
    `${blocks.length} block(s)`);

  for (const b of blocks) {
    const file = join(dir, `block${b.i}.${b.module ? "mjs" : "js"}`);
    writeFileSync(file, b.body);
    let err = null;
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
      // node --check puts the location and message on stderr.
      err = String(e.stderr || e.message).split("\n").slice(0, 4).join(" | ");
    }
    check(`${page} block ${b.i} (${b.module ? "module" : "classic"}) parses`,
      !err, err || `${b.body.split("\n").length} lines`);
  }
}

console.log(failures
  ? `\n${failures} CHECK(S) FAILED`
  : "\npage syntax: all checks passed");
process.exit(failures ? 1 : 0);
