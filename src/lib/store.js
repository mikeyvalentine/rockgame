// A ~40-line observable store. Screens read `store.state` and subscribe to the
// keys they care about; nothing else in the app is allowed to hold app state.

export function createStore(initial = {}) {
  let state = { ...initial };
  const subs = new Set();

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    const changed = [];
    for (const [key, value] of Object.entries(next)) {
      if (!Object.is(state[key], value)) changed.push(key);
    }
    if (!changed.length) return state;

    const prev = state;
    state = { ...state, ...next };
    for (const sub of [...subs]) {
      if (!sub.keys || sub.keys.some((k) => changed.includes(k))) sub.fn(state, prev, changed);
    }
    return state;
  }

  /**
   * subscribe(fn)                  — every change
   * subscribe(['session'], fn)     — only when `session` changes
   * Returns an unsubscribe function.
   */
  function subscribe(keys, fn) {
    if (typeof keys === 'function') [keys, fn] = [null, keys];
    const sub = { keys, fn };
    subs.add(sub);
    return () => subs.delete(sub);
  }

  return {
    get state() { return state; },
    get: (key) => state[key],
    set,
    subscribe,
  };
}

export const store = createStore({
  screen: null,        // current screen id, owned by the router
  backend: null,       // 'supabase' | 'local'
  session: null,       // { userId, isGuest, email } | null
  profile: null,       // { id, displayName, isGuest }
  stats: null,         // aggregate for the signed-in player
  lastRun: null,       // the run just finished, for the results screen
  loading: null,       // { phase, progress } while the loader is running
  error: null,
});
