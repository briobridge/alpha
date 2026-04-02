create table if not exists public.app_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "allow anon read app_state" on public.app_state;
create policy "allow anon read app_state"
on public.app_state
for select
to anon
using (true);

drop policy if exists "allow anon write app_state" on public.app_state;
create policy "allow anon write app_state"
on public.app_state
for insert
to anon
with check (true);

drop policy if exists "allow anon update app_state" on public.app_state;
create policy "allow anon update app_state"
on public.app_state
for update
to anon
using (true)
with check (true);

insert into public.app_state (id, data)
values ('team-alpha', '{}'::jsonb)
on conflict (id) do nothing;

create table if not exists public.backup_snapshots (
  id uuid primary key default gen_random_uuid(),
  label text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.backup_snapshots enable row level security;

drop policy if exists "allow anon read backup_snapshots" on public.backup_snapshots;
create policy "allow anon read backup_snapshots"
on public.backup_snapshots
for select
to anon
using (true);

drop policy if exists "allow anon write backup_snapshots" on public.backup_snapshots;
create policy "allow anon write backup_snapshots"
on public.backup_snapshots
for insert
to anon
with check (true);
