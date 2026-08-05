const env = import.meta.env ?? {};

export const SUPABASE_URL = (env.VITE_SUPABASE_URL || '').trim();
export const SUPABASE_ANON_KEY = (env.VITE_SUPABASE_ANON_KEY || '').trim();

/** With no credentials the app falls back to the localStorage backend. */
export const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const CLIENT_VERSION = env.VITE_APP_VERSION || '0.1.0-dev';

export const GAME = {
  /** ROCKGAME.md §1: three throws a day, best one counts. */
  throwsPerDay: 3,
  /** Leaderboard page size. */
  leaderboardSize: 25,
};

/** UTC day key — every player is on the same daily seed regardless of timezone. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}
