-- Atomically replace a day's food entry that matches a name (and optional src),
-- leaving every other food on that day untouched. Used by POST /nutrition so a
-- daily SnapCalorie/Apple Health sync can be replayed without creating duplicates.

create or replace function public.upsert_day_food_by_name(
  p_date text,
  p_food jsonb,
  p_user_id uuid default null,
  p_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
  result_data jsonb;
  match_name text;
  match_src text;
begin
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'date must be YYYY-MM-DD';
  end if;
  if p_food is null or jsonb_typeof(p_food) <> 'object' then
    raise exception 'food must be a JSON object';
  end if;

  match_name := nullif(btrim(coalesce(p_name, p_food->>'n', '')), '');
  if match_name is null then
    raise exception 'food name is required';
  end if;
  match_src := nullif(btrim(coalesce(p_food->>'src', '')), '');

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
        select coalesce(jsonb_agg(elem), '[]'::jsonb) || jsonb_build_array(p_food)
        from jsonb_array_elements(
          case
            when jsonb_typeof(public.docs.data -> 'foods') = 'array' then public.docs.data -> 'foods'
            else '[]'::jsonb
          end
        ) elem
        where not (
          elem->>'n' = match_name
          or (match_src is not null and elem->>'src' = match_src)
        )
      ),
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

revoke all on function public.upsert_day_food_by_name(text, jsonb, uuid, text) from public, anon;
grant execute on function public.upsert_day_food_by_name(text, jsonb, uuid, text) to authenticated, service_role;
