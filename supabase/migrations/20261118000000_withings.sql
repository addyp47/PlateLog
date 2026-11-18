-- Server-side storage for Withings OAuth2 connections and one-time OAuth state nonces.
-- Accessed only by Edge Functions using service_role so client_secret and OAuth tokens never reach the browser.

create table if not exists public.withings_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  withings_user_id text not null unique,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null default 'user.metrics',
  webhook_appli integer,
  webhook_callback text,
  last_synced_at timestamptz,
  last_meas_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists withings_connections_wid_idx
  on public.withings_connections (withings_user_id);

create table if not exists public.withings_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  return_to text not null default '',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists withings_oauth_states_exp_idx
  on public.withings_oauth_states (expires_at);

alter table public.withings_connections enable row level security;
alter table public.withings_oauth_states enable row level security;
