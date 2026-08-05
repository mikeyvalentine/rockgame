-- rockgame — Supabase schema
-- Paste the whole file into the Supabase SQL Editor and hit Run.
-- Idempotent: safe to re-run after edits.
--
-- Shape:
--   profiles      one row per account (incl. guests), the public-facing name
--   runs          append-only log of every throw. Never updated, never deleted.
--   player_stats  aggregate per player, maintained by a trigger on runs so the
--                 leaderboard is a cheap read instead of a scan over runs.

create extension if not exists pgcrypto;

-- ============================================================ profiles

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  is_guest     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Public player identity. Readable by everyone so leaderboards can show names.';

-- ============================================================ runs

create table if not exists public.runs (
  id         bigint generated always as identity primary key,
  player_id  uuid not null default auth.uid()
               references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- outcome
  score      real    not null check (score >= 0 and score <= 1e6),
  skips      integer not null check (skips between 0 and 500),
  distance_m real    not null check (distance_m >= 0 and distance_m <= 10000),
  duration_s real    not null check (duration_s >= 0 and duration_s <= 600),
  ended      text    check (ended in ('sank','shore','obstacle','holed','timeout','other')),

  -- reproducibility. ROCKGAME.md §10: variance must be seeded and replayable,
  -- so a run row must be enough to re-simulate the throw exactly.
  seed       text not null,
  day        date not null default (now() at time zone 'utc')::date,
  attempt    smallint check (attempt between 1 and 3),

  -- the rock
  rock_id          text,
  rock_mass_kg     real,
  rock_radius_m    real,
  rock_thickness_m real,

  -- the throw
  launch_speed_ms  real,
  launch_angle_deg real,
  attack_angle_deg real,
  spin_rps         real,
  tilt_deg         real,

  -- the day's conditions
  wind_ms      real,
  wind_dir_deg real,

  -- Anything not yet worth a column: per-skip log, QTE grades, timings.
  -- Add columns later when a key here proves it earns one.
  metrics jsonb not null default '{}'::jsonb,

  client_version text
);

create index if not exists runs_player_created_idx
  on public.runs (player_id, created_at desc);
create index if not exists runs_day_score_idx
  on public.runs (day, score desc);

-- ============================================================ player_stats

create table if not exists public.player_stats (
  player_id        uuid primary key references public.profiles(id) on delete cascade,
  runs             integer not null default 0,
  total_skips      integer not null default 0,
  best_skips       integer not null default 0,
  total_distance_m double precision not null default 0,
  best_distance_m  real not null default 0,
  best_score       real not null default 0,
  total_play_s     double precision not null default 0,
  first_run_at     timestamptz,
  last_run_at      timestamptz
);

create index if not exists player_stats_best_score_idx
  on public.player_stats (best_score desc);

-- ============================================================ triggers

-- New account (including anonymous ones) gets a profile and a stats row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  guest boolean := coalesce(new.is_anonymous, false);
  name  text;
begin
  name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), '')
  );

  -- Guests, and anyone whose name would fail the 2..24 check, get a generated one.
  if guest or name is null or char_length(name) < 2 then
    name := 'Skipper ' || upper(substr(replace(new.id::text, '-', ''), 1, 4));
  end if;

  insert into public.profiles (id, display_name, is_guest)
  values (new.id, left(name, 24), guest)
  on conflict (id) do nothing;

  insert into public.player_stats (player_id)
  values (new.id)
  on conflict (player_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A guest who adds an email/OAuth identity stops being a guest.
create or replace function public.handle_user_upgraded()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.is_anonymous, false) and not coalesce(new.is_anonymous, false) then
    update public.profiles
       set is_guest = false, updated_at = now()
     where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_upgraded on auth.users;
create trigger on_auth_user_upgraded
  after update on auth.users
  for each row execute function public.handle_user_upgraded();

-- Every inserted run folds into the player's aggregate.
create or replace function public.apply_run_to_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.player_stats as s (
    player_id, runs, total_skips, best_skips,
    total_distance_m, best_distance_m, best_score,
    total_play_s, first_run_at, last_run_at
  )
  values (
    new.player_id, 1, new.skips, new.skips,
    new.distance_m, new.distance_m, new.score,
    new.duration_s, new.created_at, new.created_at
  )
  on conflict (player_id) do update set
    runs             = s.runs + 1,
    total_skips      = s.total_skips + excluded.total_skips,
    best_skips       = greatest(s.best_skips, excluded.best_skips),
    total_distance_m = s.total_distance_m + excluded.total_distance_m,
    best_distance_m  = greatest(s.best_distance_m, excluded.best_distance_m),
    best_score       = greatest(s.best_score, excluded.best_score),
    total_play_s     = s.total_play_s + excluded.total_play_s,
    first_run_at     = least(coalesce(s.first_run_at, excluded.first_run_at), excluded.first_run_at),
    last_run_at      = greatest(coalesce(s.last_run_at, excluded.last_run_at), excluded.last_run_at);

  return new;
end;
$$;

drop trigger if exists on_run_inserted on public.runs;
create trigger on_run_inserted
  after insert on public.runs
  for each row execute function public.apply_run_to_stats();

-- Keep profiles.updated_at honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ============================================================ leaderboards
--
-- These views are deliberately NOT security_invoker. A player can only select
-- their OWN rows from `runs` (policy below), but the leaderboard has to
-- aggregate across everyone — so the view runs as its owner and exposes only
-- the aggregated columns. Supabase's linter will flag this; it is intended.

create or replace view public.daily_leaderboard as
select
  r.day,
  r.player_id,
  p.display_name,
  max(r.score)      as best_score,
  max(r.distance_m) as best_distance_m,
  max(r.skips)      as best_skips,
  count(*)          as attempts
from public.runs r
join public.profiles p on p.id = r.player_id
group by r.day, r.player_id, p.display_name;

create or replace view public.alltime_leaderboard as
select
  s.player_id,
  p.display_name,
  p.is_guest,
  s.best_score,
  s.best_distance_m,
  s.best_skips,
  s.runs,
  s.total_distance_m
from public.player_stats s
join public.profiles p on p.id = s.player_id
where s.runs > 0;

grant select on public.daily_leaderboard   to anon, authenticated;
grant select on public.alltime_leaderboard to anon, authenticated;

-- ============================================================ RLS

alter table public.profiles     enable row level security;
alter table public.runs         enable row level security;
alter table public.player_stats enable row level security;

-- profiles: world-readable (names on leaderboards), self-writable.
drop policy if exists profiles_read_all  on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;

create policy profiles_read_all on public.profiles
  for select to anon, authenticated using (true);

create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- runs: you may append your own and read your own. No update, no delete —
-- history is immutable, and the absence of those policies is what enforces it.
drop policy if exists runs_insert_own on public.runs;
drop policy if exists runs_read_own   on public.runs;

create policy runs_insert_own on public.runs
  for insert to authenticated with check (player_id = auth.uid());

create policy runs_read_own on public.runs
  for select to authenticated using (player_id = auth.uid());

-- player_stats: world-readable, never client-writable. Only the
-- security-definer trigger above may write it.
drop policy if exists stats_read_all on public.player_stats;

create policy stats_read_all on public.player_stats
  for select to anon, authenticated using (true);

-- ============================================================ note on trust
--
-- A client can currently POST any run it likes — the checks above bound the
-- numbers but do not prove they were played. That is fine for now and it is
-- deliberately concentrated in ONE place: the insert into `runs`. When it
-- matters, replace the direct insert with a security-definer RPC that
-- re-simulates the throw from `seed` + the launch parameters and rejects rows
-- whose outcome doesn't match. `skip-physics.js` is already headless and
-- deterministic, which is what makes that possible.
