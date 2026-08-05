// Shared bits of chrome. Small on purpose — if a helper here is only used once,
// it belongs in the screen that uses it.

import { h } from '../lib/dom.js';

export const panel = (...children) => h('section.panel', {}, children);

export const title = (text, sub) =>
  h('header.panel-head', {}, h('h1', {}, text), sub && h('p.sub', {}, sub));

export function button(label, { onclick, variant = 'default', type = 'button', disabled } = {}) {
  return h(`button.btn.btn-${variant}`, { type, onclick, disabled }, label);
}

export function field({ label, name, type = 'text', value = '', autocomplete, required, placeholder, minlength }) {
  const input = h('input', { type, name, value, autocomplete, required, placeholder, minlength, id: `f-${name}` });
  return {
    input,
    node: h('label.field', {}, h('span', {}, label), input),
  };
}

/** A progress bar the loader can drive. `set(fraction, label)`. */
export function progressBar() {
  const fill = h('.bar-fill');
  const text = h('.bar-label');
  const node = h('.bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('.bar-track', {}, fill), text);

  return {
    node,
    set(fraction, label) {
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      fill.style.width = `${pct}%`;
      node.setAttribute('aria-valuenow', String(pct));
      if (label != null) text.textContent = label;
    },
  };
}

export function errorNote(message) {
  return message ? h('p.error', { role: 'alert' }, message) : null;
}

/** Top bar shown on every screen except splash and game. */
export function chrome({ profile, navigate, active }) {
  const link = (id, label) =>
    h('button.navlink', {
      onclick: () => navigate(id),
      'aria-current': active === id ? 'page' : null,
      class: active === id ? 'is-active' : '',
    }, label);

  return h('nav.chrome', {},
    h('.brand', { onclick: () => navigate('menu') }, 'rockgame'),
    h('.navlinks', {}, link('menu', 'Labs'), link('leaderboard', 'Leaderboard'), link('profile', 'Profile')),
    h('.who', {},
      profile
        ? h('button.navlink', { onclick: () => navigate('profile') },
            profile.displayName, profile.isGuest && h('span.tag', {}, 'guest'))
        : null,
    ),
  );
}
