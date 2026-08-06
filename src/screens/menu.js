// The landing page. Deliberately throwaway: a hub for the feature labs that
// now live in this repo, until the real game replaces it. The placeholder
// throw ("the simple rockgame mockup") is gone — src/game/ and the play screen
// were deleted with it.

import { h, mount, disposers, fmt } from '../lib/dom.js';
import { panel, title, button, chrome } from './ui.js';
import { store } from '../lib/store.js';

// Two kinds of link. Pages under this origin are served by this dev server
// straight from the repo (they're static, or plain ES modules). The Vite labs
// have their own dependency trees: in dev they live on their own ports
// (`npm run dev` at the repo root starts all of them), while the deployed
// site (tools/build-site.mjs) mounts their builds under one origin.
const DEV = Boolean(import.meta.env?.DEV);
const LABS = [
  {
    name: 'Skip lab',
    href: '/babylon-water/index.html',
    note: 'The pond and the 6-DOF solver on one page — throw a stone at the real water.',
  },
  {
    name: 'Props',
    href: '/props/preview.html',
    note: 'Optimized GLB props — buckets and batteries under the shared HDRI.',
  },
  {
    name: 'Rock forge',
    href: DEV ? 'http://localhost:5184/' : '/rock-forge/',
    port: DEV ? 5184 : null,
    note: 'Procedural rock geometry — one topology, per-rock shape textures.',
  },
  {
    name: 'Rock sift',
    href: DEV ? 'http://localhost:5183/' : '/rock-sift/',
    port: DEV ? 5183 : null,
    note: 'The shore — Havok rock bed, dig through it, pick a skipper.',
  },
  {
    name: 'Sand sim',
    href: DEV ? 'http://localhost:5185/' : '/sand-sim/',
    port: DEV ? 5185 : null,
    note: 'First-person beach sand, WebGPU (add ?webgl=1 for the fallback).',
  },
];

export function menuScreen({ host, navigate }) {
  const dispose = disposers();

  function render() {
    const { profile, stats } = store.state;

    mount(host,
      chrome({ profile, navigate, active: 'menu' }),
      h('main.center', {},
        panel(
          title('Labs', 'Every piece of the game, in its own page. The scribble dials carry across all of them.'),

          h('ul.labs', {},
            LABS.map((lab) =>
              h('li', {},
                h('a.lab', { href: lab.href },
                  h('.lab-name', {}, lab.name, lab.port ? h('span.tag', {}, `:${lab.port}`) : null),
                  h('p.hint', {}, lab.note),
                ),
              ),
            ),
          ),

          h('p.hint.muted', {},
            'Port-numbered labs need their own dev server — `npm run dev` at the repo root starts every one.'),

          h('.stack', {},
            button('Leaderboard', { onclick: () => navigate('leaderboard') }),
          ),

          stats && stats.runs > 0
            ? h('dl.statgrid', {},
                stat('Best score', fmt.int(stats.bestScore)),
                stat('Best distance', fmt.metres(stats.bestDistanceM)),
                stat('Most skips', fmt.int(stats.bestSkips)),
                stat('Throws', fmt.int(stats.runs)),
              )
            : null,

          profile?.isGuest
            ? h('p.hint', {},
                'Playing as a guest. ',
                h('button.linkish', { onclick: () => navigate('profile') }, 'Claim your account'),
                ' to keep these stats.')
            : null,
        ),
      ),
    );
  }

  const stat = (label, value) => h('.stat', {}, h('dt', {}, label), h('dd', {}, value));

  dispose(store.subscribe(['profile', 'stats'], () => host.isConnected && render()));
  render();

  return dispose.all;
}
