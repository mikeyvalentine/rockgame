// Assemble the whole monorepo into ONE deployable static site in dist/:
//
//   /                     hub (accounts, menu, leaderboard — the app shell)
//   /rock-sift/           }
//   /rock-forge/          } the Vite labs, each built with --base=/<name>/
//   /sand-sim/            }
//   /babylon-water/       static page, copied as-is
//   /stone-skipping-physics/{demo,src}/   static page + the modules it imports
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
//   bundled module/asset URLs.
//
//   node tools/build-site.mjs        (or: npm run build:site)

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");

const run = (cmd, cwd = ROOT) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

// ------------------------------------------------------------------- builds
run("npx vite build");

for (const lab of ["rock-sift", "rock-forge", "sand-sim"]) {
  run(`npx vite build --base=/${lab}/`, join(ROOT, lab));
  cpSync(join(ROOT, lab, "dist"), join(DIST, lab), { recursive: true });
}

// ------------------------------------------------- static pages + shared code
cpSync(join(ROOT, "babylon-water"), join(DIST, "babylon-water"), { recursive: true });
for (const dir of ["demo", "src"]) {
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
