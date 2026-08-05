import { h, mount, disposers } from '../lib/dom.js';
import { panel, title, button, field, errorNote } from './ui.js';
import { store } from '../lib/store.js';
import { signInGuest, signInEmail, signUpEmail, signInGoogle } from '../services/session.js';

export function authScreen({ host, params, navigate }) {
  const dispose = disposers();
  let mode = params.mode === 'signup' ? 'signup' : 'signin';
  let error = null;
  let notice = null;
  let busy = false;

  function render() {
    const email = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true });
    const password = field({
      label: 'Password',
      name: 'password',
      type: 'password',
      autocomplete: mode === 'signup' ? 'new-password' : 'current-password',
      required: true,
      minlength: 8,
    });
    const name = mode === 'signup'
      ? field({ label: 'Display name', name: 'displayName', placeholder: 'Shown on the leaderboard', minlength: 2 })
      : null;

    const form = h('form.stack', {
      onsubmit: (event) => {
        event.preventDefault();
        run(async () => {
          const creds = {
            email: email.input.value.trim(),
            password: password.input.value,
            displayName: name?.input.value.trim() || undefined,
          };
          if (mode === 'signup') {
            const result = await signUpEmail(creds);
            if (result.needsConfirmation) {
              notice = `Check ${creds.email} for a confirmation link, then sign in.`;
              mode = 'signin';
              return render();
            }
          } else {
            await signInEmail(creds);
          }
          navigate('menu');
        });
      },
    },
      name?.node,
      email.node,
      password.node,
      button(mode === 'signup' ? 'Create account' : 'Sign in', { type: 'submit', variant: 'primary', disabled: busy }),
    );

    mount(host,
      h('.center', {},
        panel(
          title('rockgame', 'Three throws a day. Best one counts.'),

          h('.stack', {},
            button('Play as guest', {
              variant: 'primary',
              disabled: busy,
              onclick: () => run(async () => { await signInGuest(); navigate('menu'); }),
            }),
            h('p.hint', {}, 'No account needed. Your throws are saved and you can claim them later.'),
          ),

          h('.rule', {}, h('span', {}, 'or')),

          h('.stack', {},
            button('Continue with Google', {
              disabled: busy,
              onclick: () => run(() => signInGoogle()),
            }),
          ),

          form,

          notice && h('p.notice', {}, notice),
          errorNote(error),

          h('p.hint', {},
            mode === 'signup' ? 'Already have an account? ' : 'No account yet? ',
            h('button.linkish', {
              onclick: () => { mode = mode === 'signup' ? 'signin' : 'signup'; error = null; render(); },
            }, mode === 'signup' ? 'Sign in' : 'Create one'),
          ),

          store.get('backend') === 'local'
            ? h('p.hint.muted', {}, 'Local-storage mode: accounts live in this browser only, and Google sign-in is unavailable.')
            : null,
        ),
      ),
    );
  }

  async function run(fn) {
    busy = true; error = null; notice = null; render();
    try {
      await fn();
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
      if (host.isConnected) render();
    }
  }

  render();
  return dispose.all;
}
