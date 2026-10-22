-- Discord (docs/superpowers/specs/2026-10-22-discord-design.md DC1, DC2): a workspace's Discord channel webhook, where
-- the bills the agent stopped for a person are posted with a link to review each. Re-runnable, as every migration here:
-- db:migrate applies them all in order.
--
-- A platform table, like slack_installs (0067): RLS is on, no policy exists for any browser or tenant role, and only the
-- service role reads or writes it. The webhook's URL is a credential (anyone holding it can post to the channel), so it
-- is stored only as an envelope under the platform master key, bound to the workspace and the column; the app rebuilds
-- it as https://discord.com/api/webhooks/{id}/{token} from the parts it checked, and never stores the string pasted.
-- A workspace has one connection, and it goes with the workspace.

create table if not exists public.discord_webhooks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null constraint discord_webhooks_org_id_key unique
                            references public.orgs (id) on delete cascade,
  -- Discord's snowflakes: the webhook's own id, the channel it posts to, and the server the channel is in.
  webhook_id       text not null constraint discord_webhooks_webhook_id_check check (webhook_id ~ '^[0-9]{17,20}$'),
  channel_id       text not null constraint discord_webhooks_channel_id_check check (channel_id ~ '^[0-9]{17,20}$'),
  guild_id         text constraint discord_webhooks_guild_id_check check (guild_id is null or guild_id ~ '^[0-9]{17,20}$'),
  -- The webhook's name in Discord, as the channel's settings show it.
  name             text not null constraint discord_webhooks_name_check check (char_length(name) between 1 and 80),
  webhook_url_enc  jsonb not null,
  connected_by     uuid references auth.users (id) on delete set null,
  connected_at     timestamptz not null default now(),
  -- The last ledger entry the channel was told about (DC3).
  notified_seq     bigint not null default 0,
  -- The last post Discord did not take, and how many in a row (DC5): shown in Settings, cleared by the next one it takes.
  last_error       text constraint discord_webhooks_last_error_check check (last_error is null or char_length(last_error) <= 300),
  last_error_at    timestamptz,
  failures         int not null default 0 constraint discord_webhooks_failures_check check (failures >= 0)
);

alter table public.discord_webhooks enable row level security;
revoke all privileges on table public.discord_webhooks from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.discord_webhooks to service_role;

-- Rollback:
-- drop table if exists public.discord_webhooks;
