# rockgame

The app the stone-skipping game actually ships as: splash, accounts, loading,
menu, results, leaderboard, profile — plus the database the stats live in, and
**every feature lab in one repo**, each living in its own page:

| Folder | Lab | Dev URL |
| --- | --- | --- |
| `babylon-water/` | the water surface (static page, Babylon via CDN) | http://localhost:5180/babylon-water/index.html |
| `stone-skipping-physics/` | 6-DOF flight/skip solver + 3D viewer (static page) | http://localhost:5180/stone-skipping-physics/demo/index.html |
| `props/` | optimized GLB props preview (static page, model-viewer) | http://localhost:5180/props/preview.html |
| `rock-forge/` | procedural rock geometry + texture set (Vite) | http://localhost:5184 |
| `rock-sift/` | the shore, sifting, picking a stone (Vite) | http://localhost:5183 |
| `sand-sim/` | first-person beach sand, WebGPU (Vite) | http://localhost:5185 |

The two static pages are served by the hub's own dev server; the three Vite
labs keep their own dependency trees (`sand-sim` is on Babylon 9, the rest on
Babylon 8) and their own ports. The menu screen links to all five, and the
scribble/pastel dial panel carries its settings across every page (a cookie —
localhost cookies ignore ports).

```
npm run install:all   # root + the three Vite labs
npm run dev           # hub on 5180 + sift 5183 + forge 5184 + sand 5185
npm run dev:hub       # just the app shell on 5180
npm test              # store, loader, backend contract, schema drift
```

The gameplay itself is **not** wired into the shell yet — the labs are the
parts, and they get pulled in one at a time (the placeholder toy throw that
used to sit behind `src/game/engine.js` is gone).

With no `.env` the app runs entirely on `localStorage` — sign-in, stats and
leaderboard all work, they are just confined to your browser. The splash screen
says which backend is live. That is the mode to develop screens in.

## Setting up Supabase

1. Create a project at [supabase.com](https://supabase.com/dashboard) (free tier
   is fine). Save the database password somewhere.
2. **SQL Editor → New query** → paste all of [`supabase/schema.sql`](supabase/schema.sql)
   → **Run**. It is idempotent, so re-run it after any edit.
3. **Authentication → Sign In / Providers**:
   - **Email** — on. For local dev turn *Confirm email* off, or every signup
     needs a mailbox round trip.
   - **Anonymous sign-ins** — on. Without it, "Play as guest" fails with a clear
     error message telling you exactly this.
   - **Google** — on, with a client ID/secret from the Google Cloud console.
     Add Supabase's callback URL (shown under the provider) as an authorised
     redirect URI there.
4. **Authentication → URL Configuration** → add `http://localhost:5180` to
   *Redirect URLs*, or the OAuth round trip lands nowhere.
5. **Project Settings → Data API** for the URL, **→ API Keys** for the
   publishable (anon) key. Put both in `.env`:

   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<publishable key>
   ```

   Both are public by design — RLS is what protects the data. The `service_role`
   key must never go in a browser bundle.
6. Restart `npm run dev` (Vite reads `.env` at startup).

Optional, for guests linking Google rather than email: **Authentication →
Providers → Manual linking** must be on, or `linkIdentity()` is rejected.

## Shape

```
src/
  main.js              routes + boot
  config.js            env, daily-throw count, UTC day key
  lib/                 h()/mount() DOM helpers, the observable store
  app/router.js        hash router, one screen mounted at a time
  loader/              weighted load queue + what it loads
  screens/             splash, auth, menu (the labs hub), results, leaderboard, profile
  services/
    session.js         the only writer of session/profile/stats
    backend/           local.js and supabase.js behind one interface
shared/                scribble dial panel + settings shared by every lab page
supabase/schema.sql    tables, triggers, views, RLS
tools/                 node tests, no browser
```

Two rules the layout is built around:

- **Nothing above `services/backend/` knows Supabase exists.** That is what lets
  the app boot with no credentials, and what will let a real server replace it.
- **`services/session.js` is the only module that writes session/profile/stats
  into the store.** Screens read and call actions.

## Where the game comes from

| Folder | Brings |
| --- | --- |
| `./stone-skipping-physics` | the 6-DOF flight/skip solver, already headless and deterministic |
| `./babylon-water` | the water surface |
| `./rock-forge` | procedural rock geometry + the texture set (repo tracks only the 7 materials the code loads; full 45-material library lives on `D:\Textures`) |
| `./rock-sift` | the shore, and picking a stone off it |
| `./sand-sim` | the beach — deformable sand heightfield (WebGPU, WebGL fallback) |
| `Desktop/rockgame-prototype` (still external) | throw meter, per-skip QTE, aim arc, the par-3 hole rules, `ROCKGAME.md` |

Each one becomes an entry in `src/loader/manifest.js`'s `gameTasks` as it is
wired into the real game. Until then each is reachable as its own page from the
menu.

## Data model

- `profiles` — one row per account including guests. World-readable, because
  leaderboards show names.
- `runs` — append-only log of every throw. Insert-and-select-your-own only; the
  absence of update/delete policies is what makes history immutable. Carries the
  seed and launch parameters so a run can be re-simulated from its row.
- `player_stats` — per-player aggregate, maintained by a trigger on `runs`, so
  the leaderboard is a cheap indexed read instead of a scan.

A guest is a real `auth.users` row, so claiming an account later keeps the same
id and every run attached to it.

### Trust

The client can currently post any run it likes. The column `check` constraints
bound the numbers but do not prove anything was played. That is deliberate for
now and deliberately concentrated in one place — the insert into `runs`. When it
matters, that becomes a security-definer RPC that re-simulates the throw from
`seed` and rejects rows whose outcome doesn't match. `stone-skipping-physics` is
already headless and deterministic, which is what makes that possible.
