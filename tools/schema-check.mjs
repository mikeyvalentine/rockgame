// node tools/schema-check.mjs
//
// Guards the seam between supabase/schema.sql and the client that writes to it.
// Every column the Supabase backend inserts into `runs` must actually exist,
// and every table/view/policy the client reads must be defined. Drift here
// fails as a PostgREST 400 at runtime, which is a bad place to find it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(join(root, 'supabase/schema.sql'), 'utf8');
const client = readFileSync(join(root, 'src/services/backend/supabase.js'), 'utf8');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

/** Column names declared in `create table ... public.<name> ( ... )`. */
function columnsOf(table) {
  const start = sql.indexOf(`create table if not exists public.${table} (`);
  assert.notEqual(start, -1, `no create table for ${table}`);

  const open = sql.indexOf('(', start);
  let depth = 0;
  let end = open;
  for (; end < sql.length; end += 1) {
    if (sql[end] === '(') depth += 1;
    else if (sql[end] === ')') { depth -= 1; if (depth === 0) break; }
  }

  // Strip comments BEFORE splitting: a `--` comment can contain commas, and
  // those would otherwise be read as column separators.
  const body = sql.slice(open + 1, end).replace(/--.*$/gm, '');
  const columns = [];
  let depthInBody = 0;
  let line = '';
  for (const char of body) {
    if (char === '(') depthInBody += 1;
    if (char === ')') depthInBody -= 1;
    if (char === ',' && depthInBody === 0) { columns.push(line); line = ''; }
    else line += char;
  }
  columns.push(line);

  return columns
    .map((c) => c.trim())
    .filter((c) => c && !/^(primary|foreign|unique|check|constraint)\b/i.test(c))
    .map((c) => c.split(/\s+/)[0]);
}

const runColumns = columnsOf('runs');

test('every table the client touches is defined', () => {
  for (const table of ['profiles', 'runs', 'player_stats']) {
    assert.ok(sql.includes(`create table if not exists public.${table}`), `missing table ${table}`);
  }
});

test('every leaderboard view the client queries is defined', () => {
  for (const view of ['daily_leaderboard', 'alltime_leaderboard']) {
    assert.ok(sql.includes(`create or replace view public.${view}`), `missing view ${view}`);
    assert.ok(
      new RegExp(`grant select on public\\.${view}\\b`).test(sql),
      `view ${view} is never granted to anon/authenticated — it will 401`,
    );
  }
});

test('recordRun only writes columns that exist on runs', () => {
  const block = client.slice(client.indexOf('async recordRun('), client.indexOf('async getPlayerStats('));
  const rowLiteral = block.slice(block.indexOf('const row = {'), block.indexOf('};'));
  const written = [...rowLiteral.matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => m[1]);

  assert.ok(written.length > 10, `only parsed ${written.length} columns — the parser has drifted`);
  for (const column of written) {
    assert.ok(runColumns.includes(column), `recordRun writes "${column}", which runs does not have`);
  }
});

test('the columns the client reads back exist', () => {
  const selected = [
    ['player_stats', ['runs', 'total_skips', 'best_skips', 'total_distance_m',
                      'best_distance_m', 'best_score', 'total_play_s', 'first_run_at', 'last_run_at']],
    ['profiles', ['id', 'display_name', 'is_guest']],
  ];
  for (const [table, columns] of selected) {
    const defined = columnsOf(table);
    for (const column of columns) {
      assert.ok(defined.includes(column), `${table}.${column} is read by the client but not defined`);
    }
  }
});

test('row-level security is enabled on every table', () => {
  for (const table of ['profiles', 'runs', 'player_stats']) {
    assert.ok(
      new RegExp(`alter table\\s+public\\.${table}\\s+enable row level security`).test(sql),
      `RLS is not enabled on ${table} — it would be world-writable`,
    );
  }
});

test('runs has no update or delete policy — history stays immutable', () => {
  const runsPolicies = [...sql.matchAll(/create policy (\w+) on public\.runs\s+for (\w+)/g)];
  const kinds = runsPolicies.map((m) => m[2].toLowerCase());
  assert.ok(kinds.includes('insert') && kinds.includes('select'), 'runs needs insert + select policies');
  assert.ok(!kinds.includes('update'), 'a run must never be updatable');
  assert.ok(!kinds.includes('delete'), 'a run must never be deletable');
});

test('player_stats is not client-writable', () => {
  const policies = [...sql.matchAll(/create policy \w+ on public\.player_stats\s+for (\w+)/g)]
    .map((m) => m[1].toLowerCase());
  assert.deepEqual(policies, ['select'], 'only the trigger may write player_stats');
});

test('the profile and stats rows are created for new users', () => {
  assert.ok(/insert into public\.profiles/.test(sql), 'handle_new_user must create a profile');
  assert.ok(/insert into public\.player_stats/.test(sql), 'handle_new_user must create a stats row');
  assert.ok(sql.includes('after insert on auth.users'), 'the new-user trigger is not attached');
  assert.ok(sql.includes('after insert on public.runs'), 'the stats trigger is not attached');
});

console.log(`schema: ${passed} passed`);
