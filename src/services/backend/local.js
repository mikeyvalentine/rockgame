// localStorage backend. Same interface as the Supabase one, so the whole app
// runs — sign-in, stats, leaderboard — with no credentials and no network.
// Used automatically when VITE_SUPABASE_URL / _ANON_KEY are unset.
//
// It is a development stand-in, not a shipping backend: the "leaderboard" is
// only ever this browser's own players, and passwords are stored in plain text
// (see `hash()` below — deliberately not pretending otherwise).

import { CLIENT_VERSION, today } from '../../config.js';

const KEY = 'rockgame.local';

const memory = new Map();
const storage = (() => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem(KEY);
      return localStorage;
    }
  } catch { /* private mode, or Node */ }
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, v),
    removeItem: (k) => memory.delete(k),
  };
})();

const blank = () => ({ users: {}, profiles: {}, runs: [], sessionUserId: null });

function read() {
  try {
    return { ...blank(), ...JSON.parse(storage.getItem(KEY) || '{}') };
  } catch {
    return blank();
  }
}

function write(db) {
  storage.setItem(KEY, JSON.stringify(db));
  return db;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Not a password hash. This backend never leaves the machine; if it ever needs
// to, it gets replaced rather than patched.
const hash = (s) => `plain:${s}`;

const listeners = new Set();

function sessionFor(db) {
  const user = db.users[db.sessionUserId];
  if (!user) return null;
  return { userId: user.id, isGuest: user.isGuest, email: user.email || null };
}

function emit(db) {
  const session = sessionFor(db);
  for (const fn of [...listeners]) fn(session);
  return session;
}

function createUser(db, { email = null, password = null, displayName = null, isGuest = false }) {
  const id = uuid();
  db.users[id] = { id, email, password: password ? hash(password) : null, isGuest };
  db.profiles[id] = {
    id,
    displayName: displayName || (isGuest
      ? `Skipper ${id.replace(/-/g, '').slice(0, 4).toUpperCase()}`
      : (email || 'player').split('@')[0]).slice(0, 24),
    isGuest,
  };
  db.sessionUserId = id;
  return db.users[id];
}

function aggregate(runs) {
  const stats = {
    runs: runs.length,
    totalSkips: 0, bestSkips: 0,
    totalDistanceM: 0, bestDistanceM: 0,
    bestScore: 0, totalPlayS: 0,
    firstRunAt: null, lastRunAt: null,
  };
  for (const run of runs) {
    stats.totalSkips += run.skips;
    stats.bestSkips = Math.max(stats.bestSkips, run.skips);
    stats.totalDistanceM += run.distance_m;
    stats.bestDistanceM = Math.max(stats.bestDistanceM, run.distance_m);
    stats.bestScore = Math.max(stats.bestScore, run.score);
    stats.totalPlayS += run.duration_s;
    if (!stats.firstRunAt || run.created_at < stats.firstRunAt) stats.firstRunAt = run.created_at;
    if (!stats.lastRunAt || run.created_at > stats.lastRunAt) stats.lastRunAt = run.created_at;
  }
  return stats;
}

export const localBackend = {
  name: 'local',

  async init() {
    return { session: sessionFor(read()) };
  },

  onAuthChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async signInGuest() {
    const db = read();
    createUser(db, { isGuest: true });
    write(db);
    return { session: emit(db) };
  },

  async signUpEmail({ email, password, displayName }) {
    const db = read();
    if (Object.values(db.users).some((u) => u.email === email)) {
      throw new Error('That email is already registered on this device.');
    }
    createUser(db, { email, password, displayName, isGuest: false });
    write(db);
    return { session: emit(db), needsConfirmation: false };
  },

  async signInEmail({ email, password }) {
    const db = read();
    const user = Object.values(db.users).find((u) => u.email === email);
    if (!user || user.password !== hash(password)) {
      throw new Error('Wrong email or password.');
    }
    db.sessionUserId = user.id;
    write(db);
    return { session: emit(db) };
  },

  async signInGoogle() {
    throw new Error('Google sign-in needs Supabase — add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.');
  },

  async upgradeGuest({ email, password, displayName }) {
    const db = read();
    const user = db.users[db.sessionUserId];
    if (!user) throw new Error('Not signed in.');
    if (Object.values(db.users).some((u) => u.email === email && u.id !== user.id)) {
      throw new Error('That email is already registered on this device.');
    }
    user.email = email;
    user.password = hash(password);
    user.isGuest = false;
    db.profiles[user.id].isGuest = false;
    if (displayName) db.profiles[user.id].displayName = displayName.slice(0, 24);
    write(db);
    emit(db);
    return { needsConfirmation: false };
  },

  async signOut() {
    const db = read();
    db.sessionUserId = null;
    write(db);
    emit(db);
  },

  async getProfile(userId) {
    return read().profiles[userId] ?? null;
  },

  async updateProfile(userId, patch) {
    const db = read();
    const profile = db.profiles[userId];
    if (!profile) throw new Error('No such profile.');
    if (patch.displayName != null) profile.displayName = patch.displayName.slice(0, 24);
    write(db);
    return profile;
  },

  async recordRun(run) {
    const db = read();
    const row = {
      id: db.runs.length + 1,
      player_id: run.playerId,
      created_at: new Date().toISOString(),
      score: run.score,
      skips: run.skips,
      distance_m: run.distanceM,
      duration_s: run.durationS,
      ended: run.ended ?? null,
      seed: String(run.seed),
      day: run.day ?? today(),
      attempt: run.attempt ?? null,
      rock_id: run.rockId ?? null,
      metrics: run.metrics ?? {},
      client_version: CLIENT_VERSION,
    };
    db.runs.push(row);
    write(db);
    return row;
  },

  async getPlayerStats(userId) {
    return aggregate(read().runs.filter((r) => r.player_id === userId));
  },

  async getRecentRuns(userId, limit = 10) {
    return read().runs
      .filter((r) => r.player_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  },

  async countRunsToday(userId) {
    const day = today();
    return read().runs.filter((r) => r.player_id === userId && r.day === day).length;
  },

  async getLeaderboard({ scope = 'today', limit = 25 } = {}) {
    const db = read();
    const day = today();
    const best = new Map();

    for (const run of db.runs) {
      if (scope === 'today' && run.day !== day) continue;
      const row = best.get(run.player_id) ?? {
        playerId: run.player_id,
        displayName: db.profiles[run.player_id]?.displayName ?? 'Unknown',
        bestScore: 0, bestDistanceM: 0, bestSkips: 0,
      };
      row.bestScore = Math.max(row.bestScore, run.score);
      row.bestDistanceM = Math.max(row.bestDistanceM, run.distance_m);
      row.bestSkips = Math.max(row.bestSkips, run.skips);
      best.set(run.player_id, row);
    }

    return [...best.values()]
      .sort((a, b) => b.bestScore - a.bestScore)
      .slice(0, limit)
      .map((row, i) => ({ rank: i + 1, ...row }));
  },
};
