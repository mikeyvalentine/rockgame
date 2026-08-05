// node tools/backend-contract-test.mjs
//
// Two jobs:
//   1. The Supabase and localStorage backends expose the SAME interface. The
//      local one is what you develop against; a method that exists only there
//      is a bug you'd only find in production.
//   2. The local backend actually behaves — sign in, record runs, aggregate.

import assert from 'node:assert/strict';
import { localBackend } from '../src/services/backend/local.js';
import { supabaseBackend } from '../src/services/backend/supabase.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

const REQUIRED = [
  'init', 'onAuthChange', 'signInGuest', 'signUpEmail', 'signInEmail', 'signInGoogle',
  'upgradeGuest', 'signOut', 'getProfile', 'updateProfile', 'recordRun',
  'getPlayerStats', 'getRecentRuns', 'countRunsToday', 'getLeaderboard',
];

await test('both backends implement every required method', () => {
  for (const backend of [localBackend, supabaseBackend]) {
    for (const method of REQUIRED) {
      assert.equal(typeof backend[method], 'function', `${backend.name} is missing ${method}()`);
    }
  }
});

await test('neither backend has methods the other lacks', () => {
  const names = (b) => Object.keys(b).filter((k) => typeof b[k] === 'function').sort();
  assert.deepEqual(names(localBackend), names(supabaseBackend));
});

await test('guest sign-in creates a session and a profile', async () => {
  const { session } = await localBackend.signInGuest();
  assert.ok(session.userId);
  assert.equal(session.isGuest, true);
  const profile = await localBackend.getProfile(session.userId);
  assert.equal(profile.isGuest, true);
  assert.ok(profile.displayName.length >= 2);
});

await test('runs aggregate into stats', async () => {
  const { session } = await localBackend.signInGuest();
  const base = { playerId: session.userId, seed: 'test', durationS: 4 };

  await localBackend.recordRun({ ...base, score: 100, skips: 8, distanceM: 40 });
  await localBackend.recordRun({ ...base, score: 250, skips: 14, distanceM: 92 });

  const stats = await localBackend.getPlayerStats(session.userId);
  assert.equal(stats.runs, 2);
  assert.equal(stats.bestScore, 250);
  assert.equal(stats.bestSkips, 14);
  assert.equal(stats.bestDistanceM, 92);
  assert.equal(stats.totalSkips, 22);
  assert.equal(stats.totalDistanceM, 132);
  assert.equal(stats.totalPlayS, 8);
});

await test('stats are per player, not global', async () => {
  const a = (await localBackend.signInGuest()).session;
  await localBackend.recordRun({ playerId: a.userId, score: 10, skips: 1, distanceM: 5, durationS: 1, seed: 's' });
  const b = (await localBackend.signInGuest()).session;
  const stats = await localBackend.getPlayerStats(b.userId);
  assert.equal(stats.runs, 0, 'a fresh player must not inherit anyone else’s runs');
});

await test('the leaderboard ranks by best score, one row per player', async () => {
  const { session } = await localBackend.signInGuest();
  await localBackend.recordRun({ playerId: session.userId, score: 9999, skips: 30, distanceM: 400, durationS: 6, seed: 's' });

  const board = await localBackend.getLeaderboard({ scope: 'today', limit: 10 });
  assert.equal(board[0].bestScore, 9999);
  assert.equal(board[0].rank, 1);
  assert.equal(new Set(board.map((r) => r.playerId)).size, board.length, 'a player appeared twice');
  for (let i = 1; i < board.length; i += 1) {
    assert.ok(board[i - 1].bestScore >= board[i].bestScore, 'board is not sorted');
  }
});

await test('countRunsToday enforces nothing but counts correctly', async () => {
  const { session } = await localBackend.signInGuest();
  assert.equal(await localBackend.countRunsToday(session.userId), 0);
  await localBackend.recordRun({ playerId: session.userId, score: 1, skips: 1, distanceM: 1, durationS: 1, seed: 's' });
  assert.equal(await localBackend.countRunsToday(session.userId), 1);
});

await test('claiming a guest account keeps the same user id and its runs', async () => {
  const { session } = await localBackend.signInGuest();
  await localBackend.recordRun({ playerId: session.userId, score: 42, skips: 4, distanceM: 20, durationS: 2, seed: 's' });

  await localBackend.upgradeGuest({ email: `claim-${Date.now()}@example.com`, password: 'hunter2hunter2' });

  const profile = await localBackend.getProfile(session.userId);
  assert.equal(profile.isGuest, false, 'still marked as a guest after claiming');
  const stats = await localBackend.getPlayerStats(session.userId);
  assert.equal(stats.bestScore, 42, 'runs did not survive the upgrade');
});

await test('wrong password is rejected', async () => {
  const email = `login-${Date.now()}@example.com`;
  await localBackend.signUpEmail({ email, password: 'correct-horse', displayName: 'Tester' });
  await localBackend.signOut();
  await assert.rejects(() => localBackend.signInEmail({ email, password: 'wrong' }));
  const { session } = await localBackend.signInEmail({ email, password: 'correct-horse' });
  assert.ok(session.userId);
  assert.equal(session.isGuest, false);
});

await test('auth listeners fire on sign-in and sign-out', async () => {
  const seen = [];
  const off = localBackend.onAuthChange((session) => seen.push(session));
  await localBackend.signInGuest();
  await localBackend.signOut();
  off();
  assert.equal(seen.length, 2);
  assert.ok(seen[0]?.userId);
  assert.equal(seen[1], null);
});

console.log(`backend: ${passed} passed`);
