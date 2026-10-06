-- The jobs that must run on time, scheduled by Supabase Cron (pg_cron and pg_net) in the production database. GitHub
-- Actions started their 5- and 10-minute schedules only a few times a day, so they moved here on 2026-10-06; the
-- agent's six-hourly tick followed the same day (3 cycles a workspace in 24 hours, one more than 5 hours late). Each
-- one's workflow in .github/workflows stays, for a manual run. Only the sandbox cleanup (daily) can wait hours, and
-- stays on GitHub's schedule.
--
-- This is not a migration: `npm run db:migrate` applies supabase/migrations only, and these call the production
-- origin. Run it by hand in the SQL editor, after:
--   1. enabling the two extensions (Supabase's documented SQL):
--        create extension if not exists pg_cron with schema pg_catalog;
--        grant usage on schema cron to postgres;
--        grant all privileges on all tables in schema cron to postgres;
--        create extension if not exists pg_net with schema extensions;
--   2. adding the agent's bearer token (the deployment's AGENT_API_TOKEN) to Vault as `agent_api_token`, from
--      Integrations > Vault: never in the SQL editor, which keeps every query as a snippet.
--
-- Running it again is safe: cron.schedule replaces a job of the same name. Each run reads the token from Vault, so a
-- rotated AGENT_API_TOKEN needs only the Vault secret changed. pg_net keeps each request, its header included, in its
-- queue table, which any role that logs in to the database can read. pg_net posts without waiting for the last answer,
-- so the transfer watch's route ends a run within half its period (tests/supabase-cron.test.ts).
--
-- To check: select * from cron.job_run_details order by start_time desc limit 10;
--           select status_code, created from net._http_response order by created desc limit 10;
select cron.schedule('vestiarion-transfer-watch', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://www.vestiarion.xyz/api/agent/transfer-watch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'agent_api_token')),
    timeout_milliseconds := 330000)
$$);
select cron.schedule('vestiarion-fx-watch', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://www.vestiarion.xyz/api/agent/fx-watch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'agent_api_token')),
    timeout_milliseconds := 330000)
$$);
select cron.schedule('vestiarion-webhooks', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://www.vestiarion.xyz/api/platform/webhooks',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'agent_api_token')),
    timeout_milliseconds := 330000)
$$);
select cron.schedule('vestiarion-agent-tick', '17 */6 * * *', $$
  select net.http_post(
    url := 'https://www.vestiarion.xyz/api/agent/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'agent_api_token')),
    timeout_milliseconds := 330000)
$$);
