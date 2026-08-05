import './style.css';

import { store } from './lib/store.js';
import { createRouter } from './app/router.js';
import { runSplash } from './screens/splash.js';
import { authScreen } from './screens/auth.js';
import { menuScreen } from './screens/menu.js';
import { resultsScreen } from './screens/results.js';
import { leaderboardScreen } from './screens/leaderboard.js';
import { profileScreen } from './screens/profile.js';

const host = document.getElementById('app');

const routes = {
  auth: authScreen,
  menu: menuScreen,
  results: resultsScreen,
  leaderboard: leaderboardScreen,
  profile: profileScreen,
};

const router = createRouter({
  host,
  routes,
  fallback: 'menu',
  // Everything except the leaderboard needs somebody signed in — including as
  // a guest, which is one click away on the auth screen.
  guard: (id) => {
    const signedIn = Boolean(store.get('session'));
    if (!signedIn && id !== 'auth' && id !== 'leaderboard') return 'auth';
    if (signedIn && id === 'auth') return 'menu';
    return null;
  },
});

runSplash()
  .catch((err) => {
    console.error('[boot]', err);
    store.set({ error: err.message });
  })
  .then(() => router.start());

// Surfacing errors beats swallowing them; the screens show `store.error` where
// it is relevant, this is the backstop for everything else.
addEventListener('unhandledrejection', (event) => {
  console.error('[unhandled]', event.reason);
});

if (import.meta.env?.DEV) {
  Object.assign(globalThis, { store, router });
}
