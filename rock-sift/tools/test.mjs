// The suite. `npm test`.
//
// Runs the checks that assert behaviour and reports a real exit code. The two
// measurement tools — margin-test and physics-bench — are deliberately not in
// here: they produce numbers to read, not pass/fail, and physics-bench takes
// minutes. Run those by hand.

import { spawn } from "node:child_process";
// URL.pathname gives "/C:/..." on Windows, which node then resolves as a
// relative path against the drive root. fileURLToPath is the portable form.
import { fileURLToPath } from "node:url";

const SUITE = [
  { name: "winding", script: "winding-check.mjs", why: "imported stones face outwards" },
  { name: "settle", script: "settle-test.mjs", why: "the bed comes to rest where it should" },
  { name: "sift", script: "sift-test.mjs", why: "sweeping does not throw the bed around" },
  { name: "carry", script: "carry-test.mjs", why: "lifting a stone does not pop its neighbours" },
  { name: "bucket", script: "bucket-test.mjs", why: "stones dropped in the bucket stay in it" },
];

const run = (script) => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ code, out }));
});

let failed = 0;
for (const t of SUITE) {
  const started = Date.now();
  process.stdout.write(`${t.name.padEnd(9)} ${t.why.padEnd(46)}`);
  const { code, out } = await run(t.script);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (code === 0) {
    console.log(`ok    ${secs}s`);
  } else {
    failed++;
    console.log(`FAIL  ${secs}s`);
    console.log(out.split("\n").map((l) => `    ${l}`).join("\n"));
  }
}

console.log(failed ? `\n${failed} of ${SUITE.length} failed` : `\nall ${SUITE.length} passed`);
process.exit(failed ? 1 : 0);
