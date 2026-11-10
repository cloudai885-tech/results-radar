-- Run once in the Supabase SQL editor. Holds a single row with the latest ratings.
create table if not exists public.radar (
  id int primary key check (id = 1),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.radar enable row level security;

-- Anyone with the app can read. There is no write policy, so only the service key can write.
drop policy if exists "public read" on public.radar;
create policy "public read" on public.radar for select to anon using (true);
