create extension if not exists pgcrypto;

create table if not exists public.activation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan text not null default 'monthly',
  duration_days integer not null default 30,
  status text not null default 'active',
  order_no text,
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'free',
  status text not null default 'free',
  source text,
  activation_code text,
  expires_at timestamptz,
  device_limit integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  user_agent text,
  ip_address text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, device_id)
);

alter table public.activation_codes enable row level security;
alter table public.subscriptions enable row level security;
alter table public.user_devices enable row level security;

drop policy if exists "users can read own subscription" on public.subscriptions;
create policy "users can read own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "users can read own devices" on public.user_devices;
create policy "users can read own devices"
  on public.user_devices for select
  using (auth.uid() = user_id);

create index if not exists activation_codes_code_idx on public.activation_codes (code);
create index if not exists subscriptions_status_expires_idx on public.subscriptions (status, expires_at);
create index if not exists user_devices_user_seen_idx on public.user_devices (user_id, last_seen_at desc);

