// Assemble the whole monorepo into ONE deployable static site in dist/:
//
//   /                     hub (accounts, menu, leaderboard — the app shell)
//   /rock-sift/           }
//   /rock-forge/          } the Vite labs, each built with --base=/<name>/
//   /sand-sim/            }
//   /babylon-water/       static page, copied as-is
//   /stone-skipping-physics/src/       solver modules, imported by the skip lab
//   /props/               static page
//   /shared/              scribble dials (the static pages import from here)
//   /assets/              the ONE shared assets folder
//
// Two decisions worth stating:
//
//   copyPublicDir is OFF in every vite config, and /assets is copied here from
//   `git ls-files` — the local public/assets also holds the 140MB of untracked
//   texture-library material that must not ship. What deploys is exactly what
//   the repo tracks.
//
//   The labs' runtime fetches ("/assets/...") are origin-absolute on purpose:
//   under one origin every lab resolves them to the same shared folder, which
//   is the whole point of the layout. Their --base only affects their own
//   bundled module/asset URLs — except in index.html, where it does NOT, and
//   `unbaseSharedAssets` below is the repair. See its comment.
//
//   node tools/build-site.mjs        (or: npm run build:site)

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");

const run = (cmd, cwd = ROOT) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

// ------------------------------------------------------------------- builds
//
// The labs are npm WORKSPACES, so one install at the root installs every one of
// them, into one hoisted `node_modules`. That is the whole point: the labs used
// to install separately and ended up on different Babylon versions without
// anyone deciding to, and sand-sim — which imports rock-forge source directly —
// was silently loading two Babylon copies in one process.
//
// This used to walk the labs calling `npm ci` in each. Doing that now would be
// worse than redundant: the per-lab lockfiles are gone (a workspace has one
// lockfile, at the root), so it would fall through to `npm install` inside each
// lab, create nested `node_modules`, and reintroduce exactly the duplicate
// copies the workspace exists to remove.
const LABS = ["rock-sift", "rock-forge", "sand-sim", "skin-lab"];

run(existsSync(join(ROOT, "package-lock.json")) ? "npm ci" : "npm install");

run("npx vite build");

for (const lab of LABS) {
  run(`npx vite build --base=/${lab}/`, join(ROOT, lab));
  cpSync(join(ROOT, lab, "dist"), join(DIST, lab), { recursive: true });
}

/**
 * Point a lab's index.html back at the SHARED assets folder.
 *
 * The note above about --base only touching a lab's own bundle is true of
 * runtime `fetch("/assets/...")` calls, which are strings Vite never sees, and
 * false of index.html, which Vite rewrites: `<link href="/assets/fonts/...">`
 * becomes `/sand-sim/assets/fonts/...`, which does not exist. Cloudflare Pages
 * then serves the SPA fallback, and the browser refuses an HTML file offered as
 * a stylesheet —
 *
 *   Refused to apply style from '.../sand-sim/assets/fonts/stefan.css' because
 *   its MIME type ('text/html') is not a supported stylesheet MIME type
 *
 * — so every lab has been loading without its font.
 *
 * The rewrite is narrow on purpose. A lab's OWN bundle also lives under
 * `assets/` (`/sand-sim/assets/index-W2cTEBzz.js`) and must keep its base, so
 * only the shared tree's top-level directory names are un-based. Those are read
 * from what is actually being shipped rather than hardcoded, so a new shared
 * folder is covered the day it is added.
 */
function unbaseSharedAssets(html, lab) {
  if (!existsSync(html)) return;
  const shared = new Set(
    tracked
      .map((f) => f.split("/")[2])
      .filter((name) => name && !name.includes("."))
  );
  let src = readFileSync(html, "utf8");
  let fixed = 0;
  for (const dir of shared) {
    const from = `/${lab}/assets/${dir}/`;
    if (src.includes(from)) {
      src = src.split(from).join(`/assets/${dir}/`);
      fixed++;
    }
  }
  if (fixed) writeFileSync(html, src);
}

// ------------------------------------------------- static pages + shared code
cpSync(join(ROOT, "babylon-water"), join(DIST, "babylon-water"), { recursive: true });
for (const dir of ["src"]) {
  cpSync(join(ROOT, "stone-skipping-physics", dir),
    join(DIST, "stone-skipping-physics", dir), { recursive: true });
}
cpSync(join(ROOT, "props"), join(DIST, "props"), { recursive: true });
cpSync(join(ROOT, "shared"), join(DIST, "shared"), { recursive: true });

// -------------------------------------------------- assets: tracked files only
const tracked = execSync("git ls-files -z public/assets", { cwd: ROOT })
  .toString().split("\0").filter(Boolean);
if (!tracked.length) throw new Error("git ls-files returned no assets — run from the repo");
for (const rel of tracked) {
  const to = join(DIST, rel.replace(/^public[\\/]/, ""));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(ROOT, rel), to);
}

// Run AFTER the assets are enumerated, not inside the build loop: `tracked` is
// a const declared above and reading it earlier is a temporal-dead-zone error.
for (const lab of LABS) unbaseSharedAssets(join(DIST, lab, "index.html"), lab);

// ------------------------------------------------------------------- report
function mb(path) {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const cur = stack.pop();
    const st = statSync(cur);
    if (st.isDirectory()) for (const e of readdirSync(cur)) stack.push(join(cur, e));
    else total += st.size;
  }
  return (total / 1048576).toFixed(0);
}

if (!existsSync(join(DIST, "assets", "sky", "autumn_field_puresky_4k.hdr"))) {
  console.warn("WARNING: shared HDRI missing from dist/assets/sky — labs will boot dark.");
}

console.log(`\nSite assembled in dist/ (${mb(DIST)} MB).`);
console.log("Preview locally:  npx serve dist");
console.log("Deploy:           npx wrangler pages deploy dist --project-name rockgame");
