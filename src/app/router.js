// Hash router. Each screen is `(host, ctx) => cleanup?` and owns its DOM while
// it is mounted; the router calls the returned cleanup before mounting the next.

import { store } from '../lib/store.js';

export function createRouter({ host, routes, fallback = 'menu', guard }) {
  let cleanup = null;
  let currentId = null;

  function parse() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [id, query] = raw.split('?');
    return {
      id: id || fallback,
      params: Object.fromEntries(new URLSearchParams(query || '')),
    };
  }

  async function render() {
    let { id, params } = parse();
    if (!routes[id]) id = fallback;

    // A guard may redirect (e.g. no session -> auth). Re-entering render()
    // through the hashchange is fine; going straight there would double-mount.
    const redirect = guard?.(id, params);
    if (redirect && redirect !== id) return navigate(redirect, {}, { replace: true });

    try { cleanup?.(); } catch (err) { console.error('[router] cleanup', err); }
    cleanup = null;

    currentId = id;
    store.set({ screen: id });
    document.body.dataset.screen = id;

    try {
      cleanup = (await routes[id]({ host, params, navigate })) || null;
    } catch (err) {
      console.error(`[router] ${id}`, err);
      store.set({ error: err.message });
    }
  }

  function navigate(id, params = {}, { replace = false } = {}) {
    const query = new URLSearchParams(params).toString();
    const hash = `#/${id}${query ? `?${query}` : ''}`;
    if (location.hash === hash) return render();
    if (replace) history.replaceState(null, '', hash);
    else location.hash = hash;
    // replaceState doesn't fire hashchange, so drive it manually.
    if (replace) return render();
  }

  function start() {
    addEventListener('hashchange', render);
    return render();
  }

  return { start, navigate, get current() { return currentId; } };
}
