import { h, mount, disposers, fmt } from '../lib/dom.js';
import { panel, title, button, chrome, errorNote } from './ui.js';
import { store } from '../lib/store.js';

export function resultsScreen({ host, params, navigate }) {
  const dispose = disposers();
  const run = store.get('lastRun');
  const practice = params.practice === '1';

  if (!run) {
    mount(host, chrome({ profile: store.get('profile'), navigate, active: 'menu' }),
      h('main.center', {}, panel(
        title('Nothing to show', 'That throw is no longer in memory.'),
        button('Back to menu', { variant: 'primary', onclick: () => navigate('menu') }),
      )));
    return dispose.all;
  }

  // Rows come back from the DB snake_cased; the local result object is camel.
  const skips = run.skips;
  const distance = run.distance_m ?? run.distanceM;
  const score = run.score;
  const isRecord = !practice && score >= (store.get('stats')?.bestScore ?? 0);

  mount(host,
    chrome({ profile: store.get('profile'), navigate, active: 'menu' }),
    h('main.center', {},
      panel(
        title(practice ? 'Practice throw' : 'Throw complete',
          isRecord ? 'New personal best.' : null),

        h('.bigscore', {}, fmt.int(score), h('span.bigscore-unit', {}, 'score')),

        h('dl.statgrid', {},
          h('.stat', {}, h('dt', {}, 'Distance'), h('dd', {}, fmt.metres(distance))),
          h('.stat', {}, h('dt', {}, 'Skips'), h('dd', {}, fmt.int(skips))),
          h('.stat', {}, h('dt', {}, 'Quality'),
            h('dd', {}, fmt.dec(run.metrics?.quality ?? 1, 2), '×')),
        ),

        run.unsaved
          ? errorNote('This throw could not be saved. It still counted locally, but it is not on the leaderboard.')
          : null,
        practice ? h('p.hint', {}, 'Practice throws are not scored or saved.') : null,

        h('.stack', {},
          // The play screen went with the placeholder engine; home is the hub now.
          button('Back to the labs', { variant: 'primary', onclick: () => navigate('menu') }),
          button('Leaderboard', { onclick: () => navigate('leaderboard') }),
          button('Menu', { onclick: () => navigate('menu') }),
        ),
      ),
    ),
  );

  return dispose.all;
}
