-- Allow persisting coach check-in summaries alongside existing collections,
-- speed up rolling day-window queries, and provide atomic day-level RPCs
-- so concurrent phone + external API writes never clobber each other.

alter table public.docs drop constraint if exists docs_collection_check;
alter table public.docs add constraint docs_collection_check
  check (collection in ('settings', 'days', 'foods', 'combos', 'checkins', 'coach_notes'));

create index if not exists docs_user_days_desc_idx
  on public.docs (user_id, doc_id desc)
  where collection = 'days';

create or replace function public.append_day_food(
  p_date text,
  p_food jsonb,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
  result_data jsonb;
begin
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'date must be YYYY-MM-DD';
  end if;
  if p_food is null or jsonb_typeof(p_food) <> 'object' then
    raise exception 'food must be a JSON object';
  end if;

  if auth.uid() is not null then
    if p_user_id is not null and p_user_id <> auth.uid() then
      raise exception 'forbidden';
    end if;
    target_user := auth.uid();
  elsif coalesce(auth.role(), '') = 'service_role' then
    if p_user_id is null then
      raise exception 'user_id is required for service_role';
    end if;
    target_user := p_user_id;
  else
    raise exception 'unauthorized';
  end if;

  insert into public.docs (user_id, collection, doc_id, data)
  values (
    target_user,
    'days',
    p_date,
    jsonb_build_object(
      'date', p_date,
      'foods', jsonb_build_array(p_food),
      'lifts', '{}'::jsonb,
      'updated', (extract(epoch from now()) * 1000)::bigint
    )
  )
  on conflict (user_id, collection, doc_id) do update
  set data = jsonb_set(
    jsonb_set(
      case
        when jsonb_typeof(public.docs.data -> 'foods') = 'array' then public.docs.data
        else jsonb_set(public.docs.data, '{foods}', '[]'::jsonb, true)
      end,
      '{foods}',
      (
        case
          when jsonb_typeof(public.docs.data -> 'foods') = 'array' then public.docs.data -> 'foods'
          else '[]'::jsonb
        end
      ) || jsonb_build_array(p_food),
      true
    ),
    '{updated}',
    to_jsonb((extract(epoch from now()) * 1000)::bigint),
    true
  )
  returning data into result_data;

  return result_data;
end;
$$;

create or replace function public.patch_day_fields(
  p_date text,
  p_patch jsonb,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
  result_data jsonb;
begin
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'date must be YYYY-MM-DD';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be a JSON object';
  end if;

  if auth.uid() is not null then
    if p_user_id is not null and p_user_id <> auth.uid() then
      raise exception 'forbidden';
    end if;
    target_user := auth.uid();
  elsif coalesce(auth.role(), '') = 'service_role' then
    if p_user_id is null then
      raise exception 'user_id is required for service_role';
    end if;
    target_user := p_user_id;
  else
    raise exception 'unauthorized';
  end if;

  insert into public.docs (user_id, collection, doc_id, data)
  values (
    target_user,
    'days',
    p_date,
    jsonb_build_object('date', p_date, 'foods', '[]'::jsonb, 'lifts', '{}'::jsonb)
      || p_patch
      || jsonb_build_object('date', p_date, 'updated', (extract(epoch from now()) * 1000)::bigint)
  )
  on conflict (user_id, collection, doc_id) do update
  set data = public.docs.data
    || p_patch
    || jsonb_build_object('date', p_date, 'updated', (extract(epoch from now()) * 1000)::bigint)
  returning data into result_data;

  return result_data;
end;
$$;

revoke all on function public.append_day_food(text, jsonb, uuid) from public, anon;
revoke all on function public.patch_day_fields(text, jsonb, uuid) from public, anon;
grant execute on function public.append_day_food(text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.patch_day_fields(text, jsonb, uuid) to authenticated, service_role;
