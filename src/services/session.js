// The only module that writes session/profile/stats into the store. Screens
// call these actions; they never touch `backend` directly.

import { backend, BACKEND_MODE } from './backend/index.js';
import { store } from '../lib/store.js';
import { today } from '../config.js';

let unsubscribeAuth = null;

/** Pull the profile + aggregate stats for whoever is signed in. */
export async function refreshPlayer() {
  const session = store.get('session');
  if (!session) return store.set({ profile: null, stats: null });

  const [profile, stats] = await Promise.all([
    backend.getProfile(session.userId),
    backend.getPlayerStats(session.userId),
  ]);
  return store.set({ profile, stats });
}

/** Called once at boot, from the splash screen's load queue. */
export async function initSession() {
  store.set({ backend: BACKEND_MODE });

  const { session } = await backend.init();
  store.set({ session });

  unsubscribeAuth?.();
  unsubscribeAuth = backend.onAuthChange(async (next) => {
    // Ignore token refreshes that don't change who is signed in.
    const current = store.get('session');
    if (current?.userId === next?.userId && current?.isGuest === next?.isGuest) return;
    store.set({ session: next });
    await refreshPlayer().catch((err) => store.set({ error: err.message }));
  });

  if (session) await refreshPlayer();
  return session;
}

async function afterSignIn(result) {
  if (result?.session) {
    store.set({ session: result.session, error: null });
    await refreshPlayer();
  }
  return result;
}

export const signInGuest = () => backend.signInGuest().then(afterSignIn);
export const signInEmail = (creds) => backend.signInEmail(creds).then(afterSignIn);
export const signUpEmail = (creds) => backend.signUpEmail(creds).then(afterSignIn);

export const signInGoogle = () =>
  backend.signInGoogle({ isGuest: Boolean(store.get('session')?.isGuest) });

export const upgradeGuest = (creds) => backend.upgradeGuest(creds);

export async function signOut() {
  await backend.signOut();
  store.set({ session: null, profile: null, stats: null, lastRun: null });
}

export async function setDisplayName(name) {
  const session = store.get('session');
  if (!session) throw new Error('Not signed in.');
  const profile = await backend.updateProfile(session.userId, { displayName: name });
  store.set({ profile });
  return profile;
}

/**
 * Persist a finished throw and fold it into the local stats copy.
 * `run` is camelCase; the backend maps it to columns.
 */
export async function submitRun(run) {
  const session = store.get('session');
  if (!session) throw new Error('Not signed in.');

  const row = await backend.recordRun({
    ...run,
    playerId: session.userId,
    day: run.day ?? today(),
  });

  store.set({ lastRun: row });
  await refreshPlayer().catch(() => {});
  return row;
}

export const throwsUsedToday = () => {
  const session = store.get('session');
  return session ? backend.countRunsToday(session.userId) : Promise.resolve(0);
};

export const getLeaderboard = (opts) => backend.getLeaderboard(opts);
export const getRecentRuns = (limit) => {
  const session = store.get('session');
  return session ? backend.getRecentRuns(session.userId, limit) : Promise.resolve([]);
};
