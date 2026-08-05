import { h, mount, disposers, fmt } from '../lib/dom.js';
import { panel, title, chrome, errorNote } from './ui.js';
import { store } from '../lib/store.js';
import { getLeaderboard } from '../services/session.js';
import { GAME } from '../config.js';

export function leaderboardScreen({ host, params, navigate }) {
  const dispose = disposers();
  let scope = params.scope === 'alltime' ? 'alltime' : 'today';
  let rows = null;
  let error = null;

  function render() {
    const me = store.get('session')?.userId;

    mount(host,
      chrome({ profile: store.get('profile'), navigate, active: 'leaderboard' }),
      h('main.center', {},
        panel(
          title('Leaderboard'),

          h('.tabs', {},
            tab('today', 'Today'),
            tab('alltime', 'All time'),
          ),

          errorNote(error),

          rows == null ? h('p.hint', {}, 'Loading…')
          : rows.length === 0 ? h('p.hint', {}, 'No throws yet. Be the first.')
          : h('ol.board', {}, rows.map((row) =>
              h('li.board-row', { class: row.playerId === me ? 'is-me' : '' },
                h('span.board-rank', {}, `${row.rank}`),
                h('span.board-name', {}, row.displayName),
                h('span.board-score', {}, fmt.int(row.bestScore)),
                h('span.board-detail', {}, `${fmt.metres(row.bestDistanceM)} · ${fmt.int(row.bestSkips)} skips`),
              ))),
        ),
      ),
    );
  }

  const tab = (id, label) =>
    h('button.tab', {
      class: scope === id ? 'is-active' : '',
      onclick: () => { if (scope !== id) { scope = id; rows = null; render(); load(); } },
    }, label);

  function load() {
    getLeaderboard({ scope, limit: GAME.leaderboardSize })
      .then((data) => { rows = data; error = null; })
      .catch((err) => { rows = []; error = err.message; })
      .then(() => host.isConnected && render());
  }

  render();
  load();
  return dispose.all;
}
