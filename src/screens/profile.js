import { h, mount, disposers, fmt } from '../lib/dom.js';
import { panel, title, button, field, chrome, errorNote } from './ui.js';
import { store } from '../lib/store.js';
import { setDisplayName, signOut, upgradeGuest, signInGoogle, getRecentRuns } from '../services/session.js';

export function profileScreen({ host, navigate }) {
  const dispose = disposers();
  let error = null;
  let notice = null;
  let busy = false;
  let runs = null;

  function render() {
    const { profile, stats, session } = store.state;
    if (!profile) {
      mount(host, h('main.center', {}, panel(title('Not signed in'),
        button('Sign in', { variant: 'primary', onclick: () => navigate('auth') }))));
      return;
    }

    const name = field({ label: 'Display name', name: 'displayName', value: profile.displayName, minlength: 2, required: true });

    mount(host,
      chrome({ profile, navigate, active: 'profile' }),
      h('main.center', {},
        panel(
          title(profile.displayName, session?.email || (profile.isGuest ? 'Guest account' : null)),

          stats && stats.runs > 0
            ? h('dl.statgrid', {},
                stat('Best score', fmt.int(stats.bestScore)),
                stat('Best distance', fmt.metres(stats.bestDistanceM)),
                stat('Most skips', fmt.int(stats.bestSkips)),
                stat('Throws', fmt.int(stats.runs)),
                stat('Total distance', fmt.metres(stats.totalDistanceM)),
                stat('Last throw', fmt.ago(stats.lastRunAt)),
              )
            : h('p.hint', {}, 'No throws recorded yet.'),

          h('form.stack', {
            onsubmit: (event) => {
              event.preventDefault();
              run(async () => {
                await setDisplayName(name.input.value.trim());
                notice = 'Name saved.';
              });
            },
          }, name.node, button('Save name', { type: 'submit', disabled: busy })),

          profile.isGuest ? claimBlock() : null,

          notice && h('p.notice', {}, notice),
          errorNote(error),

          h('.stack', {}, button('Sign out', {
            onclick: () => run(async () => { await signOut(); navigate('auth'); }),
          })),
        ),

        panel(
          title('Recent throws'),
          runs == null ? h('p.hint', {}, 'Loading…')
          : runs.length === 0 ? h('p.hint', {}, 'Nothing yet.')
          : h('ul.runlist', {}, runs.map((r) =>
              h('li.runrow', {},
                h('span.runrow-score', {}, fmt.int(r.score)),
                h('span.runrow-detail', {}, `${fmt.metres(r.distance_m)} · ${fmt.int(r.skips)} skips`),
                h('span.runrow-when', {}, fmt.ago(r.created_at)),
              ))),
        ),
      ),
    );
  }

  function claimBlock() {
    const email = field({ label: 'Email', name: 'claimEmail', type: 'email', autocomplete: 'email', required: true });
    const password = field({ label: 'Password', name: 'claimPassword', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });

    return h('.claim', {},
      h('h2', {}, 'Claim this account'),
      h('p.hint', {}, 'Adds a permanent login to this guest account. Your throws and stats carry over.'),
      h('form.stack', {
        onsubmit: (event) => {
          event.preventDefault();
          run(async () => {
            const result = await upgradeGuest({
              email: email.input.value.trim(),
              password: password.input.value,
            });
            notice = result.needsConfirmation
              ? `Check ${email.input.value.trim()} for a confirmation link to finish claiming the account.`
              : 'Account claimed.';
          });
        },
      }, email.node, password.node, button('Claim account', { type: 'submit', variant: 'primary', disabled: busy })),
      h('.stack', {}, button('Link Google instead', { disabled: busy, onclick: () => run(() => signInGoogle()) })),
    );
  }

  const stat = (label, value) => h('.stat', {}, h('dt', {}, label), h('dd', {}, value));

  async function run(fn) {
    busy = true; error = null; notice = null; render();
    try { await fn(); } catch (err) { error = err.message; }
    finally { busy = false; if (host.isConnected) render(); }
  }

  dispose(store.subscribe(['profile', 'stats'], () => host.isConnected && render()));
  render();

  getRecentRuns(10)
    .then((data) => { runs = data; })
    .catch(() => { runs = []; })
    .then(() => host.isConnected && render());

  return dispose.all;
}
