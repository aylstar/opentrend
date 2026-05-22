create extension if not exists pgcrypto;

create table if not exists public.activation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan text not null default 'monthly',
  duration_days integer not null default 30,
  status text not null default 'active',
  order_no text,
  created_at timestamptz not null default now()
);

alter table public.activation_codes add column if not exists device_limit integer;
alter table public.activation_codes add column if not exists activated_at timestamptz;
alter table public.activation_codes add column if not exists expires_at timestamptz;
alter table public.activation_codes add column if not exists last_seen_at timestamptz;
alter table public.activation_codes add column if not exists order_no text;
alter table public.activation_codes add column if not exists status text not null default 'active';

create table if not exists public.code_devices (
  id uuid primary key default gen_random_uuid(),
  code text not null references public.activation_codes(code) on delete cascade,
  device_id text not null,
  user_agent text,
  ip_address text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (code, device_id)
);

alter table public.activation_codes enable row level security;
alter table public.code_devices enable row level security;

create index if not exists activation_codes_code_idx on public.activation_codes (code);
create index if not exists activation_codes_status_expires_idx on public.activation_codes (status, expires_at);
create index if not exists code_devices_code_seen_idx on public.code_devices (code, last_seen_at desc);

