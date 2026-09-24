-- Vestiarion is rendered by the server with a service-role client. The
-- browser has no legitimate direct table access, so public Data API roles
-- receive neither object privileges nor permissive RLS policies.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'accounts', 'counterparties', 'invoices', 'milestones',
    'treasury_actions', 'compliance_checks', 'forecasts',
    'ledger_entries', 'sim_clock'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', table_name || '_public_read', table_name);
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all privileges on table public.%I from anon, authenticated', table_name);
    execute format('grant all privileges on table public.%I to service_role', table_name);
  end loop;
end $$;

revoke all privileges on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function public.append_ledger_entry(text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
revoke execute on function public.advance_sim_day()
  from public, anon, authenticated;
grant execute on function public.append_ledger_entry(text, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function public.advance_sim_day()
  to service_role;

-- Keep future objects private by default. Each later migration must opt the
-- service role in explicitly and still enable RLS for exposed-schema tables.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, select, update on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
