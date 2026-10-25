-- Run in Supabase Dashboard > SQL Editor. Service-role key stays on the server only.
create extension if not exists pgcrypto;

create table if not exists public.sensor_readings (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  ax double precision, ay double precision, az double precision,
  gx double precision, gy double precision, gz double precision,
  source text not null default 'device' check (source in ('device','test')),
  occurred_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sensor_readings_device_time_idx on public.sensor_readings (device_id, occurred_at desc);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  type text not null check (type in ('possible_fall','manual_help','check_in','other')),
  source text not null default 'device' check (source in ('device','test')),
  status text not null default 'active' check (status in ('active','acknowledged','resolved')),
  message text,
  occurred_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  reading_id uuid references public.sensor_readings(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists alerts_time_idx on public.alerts (occurred_at desc);

-- Browser clients do not access tables directly in this initial version. The Node server
-- uses its private service-role key. Enable RLS and deny anon/authenticated access by default.
alter table public.sensor_readings enable row level security;
alter table public.alerts enable row level security;
revoke all on public.sensor_readings from anon, authenticated;
revoke all on public.alerts from anon, authenticated;
