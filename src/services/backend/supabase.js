import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, CLIENT_VERSION, today } from '../../config.js';

let client = null;

/** Lazily built so importing this module with no credentials is harmless. */
function db() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Needed for the OAuth redirect back from Google.
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'rockgame.auth',
      },
    });
  }
  return client;
}

function toSession(session) {
  const user = session?.user;
  if (!user) return null;
  return {
    userId: user.id,
    isGuest: Boolean(user.is_anonymous),
    email: user.email || null,
  };
}

function toProfile(row) {
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, isGuest: row.is_guest };
}

function toStats(row) {
  return {
    runs: row?.runs ?? 0,
    totalSkips: row?.total_skips ?? 0,
    bestSkips: row?.best_skips ?? 0,
    totalDistanceM: row?.total_distance_m ?? 0,
    bestDistanceM: row?.best_distance_m ?? 0,
    bestScore: row?.best_score ?? 0,
    totalPlayS: row?.total_play_s ?? 0,
    firstRunAt: row?.first_run_at ?? null,
    lastRunAt: row?.last_run_at ?? null,
  };
}

/** Turn a PostgREST/GoTrue error into something a player can read. */
function fail(error, fallback) {
  if (!error) return;
  const msg = error.message || String(error);
  if (/anonymous sign-?ins are disabled/i.test(msg)) {
    throw new Error(
      'Guest play is turned off for this project. Enable "Allow anonymous sign-ins" ' +
      'in Supabase → Authentication → Sign In / Providers.',
    );
  }
  if (/relation "?(public\.)?(profiles|runs|player_stats)"? does not exist/i.test(msg)) {
    throw new Error('The database tables are missing — run supabase/schema.sql in the SQL editor.');
  }
  throw new Error(fallback ? `${fallback}: ${msg}` : msg);
}

export const supabaseBackend = {
  name: 'supabase',

  async init() {
    const { data, error } = await db().auth.getSession();
    if (error) fail(error, 'Could not reach Supabase');
    return { session: toSession(data.session) };
  },

  onAuthChange(fn) {
    const { data } = db().auth.onAuthStateChange((_event, session) => fn(toSession(session)));
    return () => data.subscription.unsubscribe();
  },

  async signInGuest() {
    const { data, error } = await db().auth.signInAnonymously();
    fail(error, 'Could not start a guest session');
    return { session: toSession(data.session) };
  },

  async signUpEmail({ email, password, displayName }) {
    const { data, error } = await db().auth.signUp({
      email,
      password,
      options: { data: displayName ? { display_name: displayName } : {} },
    });
    fail(error, 'Sign-up failed');
    // With email confirmation on, `session` is null until the link is clicked.
    return { session: toSession(data.session), needsConfirmation: !data.session };
  },

  async signInEmail({ email, password }) {
    const { data, error } = await db().auth.signInWithPassword({ email, password });
    fail(error, 'Sign-in failed');
    return { session: toSession(data.session) };
  },

  async signInGoogle({ isGuest = false } = {}) {
    const redirectTo = `${location.origin}${location.pathname}`;
    // A guest LINKS Google to the existing anonymous user so their runs survive;
    // anyone else signs in normally. Linking needs "Manual linking" enabled in
    // Supabase → Authentication → Providers.
    const call = isGuest
      ? db().auth.linkIdentity({ provider: 'google', options: { redirectTo } })
      : db().auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    const { error } = await call;
    fail(error, 'Google sign-in failed');
    return { redirecting: true };
  },

  async upgradeGuest({ email, password, displayName }) {
    const { data, error } = await db().auth.updateUser({
      email,
      password,
      data: displayName ? { display_name: displayName } : undefined,
    });
    fail(error, 'Could not upgrade the guest account');
    if (displayName && data?.user) {
      await this.updateProfile(data.user.id, { displayName });
    }
    // Supabase emails a confirmation link; is_anonymous flips only once it's clicked.
    return { needsConfirmation: true };
  },

  async signOut() {
    const { error } = await db().auth.signOut();
    fail(error, 'Sign-out failed');
  },

  async getProfile(userId) {
    const { data, error } = await db()
      .from('profiles').select('id, display_name, is_guest').eq('id', userId).maybeSingle();
    fail(error, 'Could not load your profile');
    return toProfile(data);
  },

  async updateProfile(userId, patch) {
    const row = {};
    if (patch.displayName != null) row.display_name = patch.displayName;
    const { data, error } = await db()
      .from('profiles').update(row).eq('id', userId)
      .select('id, display_name, is_guest').single();
    fail(error, 'Could not save your profile');
    return toProfile(data);
  },

  async recordRun(run) {
    const row = {
      player_id: run.playerId,
      score: run.score,
      skips: run.skips,
      distance_m: run.distanceM,
      duration_s: run.durationS,
      ended: run.ended ?? null,
      seed: String(run.seed),
      day: run.day ?? today(),
      attempt: run.attempt ?? null,
      rock_id: run.rockId ?? null,
      rock_mass_kg: run.rockMassKg ?? null,
      rock_radius_m: run.rockRadiusM ?? null,
      rock_thickness_m: run.rockThicknessM ?? null,
      launch_speed_ms: run.launchSpeedMs ?? null,
      launch_angle_deg: run.launchAngleDeg ?? null,
      attack_angle_deg: run.attackAngleDeg ?? null,
      spin_rps: run.spinRps ?? null,
      tilt_deg: run.tiltDeg ?? null,
      wind_ms: run.windMs ?? null,
      wind_dir_deg: run.windDirDeg ?? null,
      metrics: run.metrics ?? {},
      client_version: CLIENT_VERSION,
    };
    const { data, error } = await db().from('runs').insert(row).select().single();
    fail(error, 'Could not save your throw');
    return data;
  },

  async getPlayerStats(userId) {
    const { data, error } = await db()
      .from('player_stats').select('*').eq('player_id', userId).maybeSingle();
    fail(error, 'Could not load your stats');
    return toStats(data);
  },

  async getRecentRuns(userId, limit = 10) {
    const { data, error } = await db()
      .from('runs').select('*').eq('player_id', userId)
      .order('created_at', { ascending: false }).limit(limit);
    fail(error, 'Could not load your recent throws');
    return data ?? [];
  },

  async countRunsToday(userId) {
    const { count, error } = await db()
      .from('runs').select('id', { count: 'exact', head: true })
      .eq('player_id', userId).eq('day', today());
    fail(error, 'Could not check today’s throws');
    return count ?? 0;
  },

  async getLeaderboard({ scope = 'today', limit = 25 } = {}) {
    const query = scope === 'today'
      ? db().from('daily_leaderboard').select('player_id, display_name, best_score, best_distance_m, best_skips')
          .eq('day', today())
      : db().from('alltime_leaderboard').select('player_id, display_name, best_score, best_distance_m, best_skips');

    const { data, error } = await query.order('best_score', { ascending: false }).limit(limit);
    fail(error, 'Could not load the leaderboard');
    return (data ?? []).map((row, i) => ({
      rank: i + 1,
      playerId: row.player_id,
      displayName: row.display_name,
      bestScore: row.best_score,
      bestDistanceM: row.best_distance_m,
      bestSkips: row.best_skips,
    }));
  },
};
