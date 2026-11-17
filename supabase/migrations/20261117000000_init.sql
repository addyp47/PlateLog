-- PlateLog storage. One row per artifact document.
-- days.energy_out is a real nullable column (reserved for a future Whoop import)
-- and is mirrored into docs.data.energy_out.

create extension if not exists pgcrypto;

create table public.docs (
  user_id uuid not null references auth.users (id) on delete cascade,
  collection text not null check (collection in ('settings', 'days', 'foods', 'combos', 'checkins')),
  doc_id text not null,
  data jsonb not null default '{}'::jsonb,
  -- Promoted from data for days only. Null on every other collection and when a day has no reading.
  energy_out double precision,
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, doc_id),
  constraint docs_energy_out_only_on_days check (
    collection = 'days' or energy_out is null
  )
);

create index docs_user_collection_idx on public.docs (user_id, collection, doc_id);

comment on column public.docs.energy_out is
  'Days only. Daily calories burned. Nullable until a Whoop (or other) import writes it. Not part of adaptive TDEE.';

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key_hash text not null unique,
  prefix text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index api_keys_user_idx on public.api_keys (user_id);

create or replace function public.sync_doc_row()
returns trigger
language plpgsql
as $$
begin
  if new.collection = 'days' then
    if jsonb_typeof(new.data -> 'energy_out') = 'number' then
      new.energy_out := (new.data ->> 'energy_out')::double precision;
    elsif new.energy_out is not null and not (new.data ? 'energy_out') then
      new.data := jsonb_set(new.data, '{energy_out}', to_jsonb(new.energy_out), true);
    else
      new.energy_out := null;
    end if;
  else
    new.energy_out := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger docs_sync
before insert or update on public.docs
for each row execute function public.sync_doc_row();

alter table public.docs enable row level security;
alter table public.api_keys enable row level security;

create policy docs_select on public.docs
  for select to authenticated
  using (user_id = auth.uid());

create policy docs_insert on public.docs
  for insert to authenticated
  with check (user_id = auth.uid());

create policy docs_update on public.docs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy docs_delete on public.docs
  for delete to authenticated
  using (user_id = auth.uid());

create policy api_keys_select on public.api_keys
  for select to authenticated
  using (user_id = auth.uid());

create policy api_keys_insert on public.api_keys
  for insert to authenticated
  with check (user_id = auth.uid());

create policy api_keys_update on public.api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy api_keys_delete on public.api_keys
  for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.docs to authenticated;
grant select, insert, update, delete on public.api_keys to authenticated;

-- Realtime so the open UI sees writes from the external API.
do $$
begin
  alter publication supabase_realtime add table public.docs;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

insert into storage.buckets (id, name, public)
values ('checkins', 'checkins', false)
on conflict (id) do nothing;

create policy checkins_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'checkins'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy checkins_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'checkins'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy checkins_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'checkins'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'checkins'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy checkins_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'checkins'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
