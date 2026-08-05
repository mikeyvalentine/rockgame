// Picks a backend and re-exports it. Everything above this file talks to the
// interface below and never to Supabase directly, which is what lets the app
// boot with no credentials and what will let a future dedicated server drop in.
//
// Interface (all async unless noted):
//   init()                          -> { session | null }
//   onAuthChange(fn)                -> unsubscribe   (not async)
//   signInGuest()                   -> { session }
//   signUpEmail({ email, password, displayName })
//   signInEmail({ email, password })
//   signInGoogle()                  -> redirects; may not resolve
//   upgradeGuest({ email, password, displayName })
//   signOut()
//   getProfile(userId)              -> profile | null
//   updateProfile(userId, patch)    -> profile
//   recordRun(run)                  -> run
//   getPlayerStats(userId)          -> stats
//   getRecentRuns(userId, limit)    -> run[]
//   countRunsToday(userId)          -> number
//   getLeaderboard({ scope, limit })-> row[]
//
// A `session` is { userId, isGuest, email }.

import { HAS_SUPABASE } from '../../config.js';
import { localBackend } from './local.js';
import { supabaseBackend } from './supabase.js';

export const backend = HAS_SUPABASE ? supabaseBackend : localBackend;
export const BACKEND_MODE = HAS_SUPABASE ? 'supabase' : 'local';
