-- Newer Supabase projects don't auto-grant table privileges to service_role.
-- Edge Functions use service_role for the Withings OAuth/connection tables and the API-key path.
grant select, insert, update, delete on public.withings_connections to service_role;
grant select, insert, update, delete on public.withings_oauth_states to service_role;
grant select, insert, update, delete on public.docs to service_role;
grant select, insert, update, delete on public.api_keys to service_role;
