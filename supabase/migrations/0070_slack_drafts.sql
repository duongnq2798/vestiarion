-- Slack design S15 (docs/superpowers/specs/2026-10-03-slack-design.md): an invoice a member chose in Slack with "Add
-- invoice to Vestiarion", read the way From a document reads one and held as a draft until they press Add, as the
-- Telegram bot holds its drafts (0064); and the permissions each install granted, so Settings can say when Slack must
-- be connected again before a file can be read. Platform tables: only the service role reads or writes them.
-- (0068 is kept for invoices by email, and 0069 is another branch's.)

-- The bot permissions Slack granted at install, as `oauth.v2.access` lists them. An install made before this
-- migration granted `commands` and `incoming-webhook` only, and starts with none recorded.
alter table public.slack_installs add column if not exists scopes text[] not null default '{}';

-- A read waiting for its Add or Cancel: used once, within the hour, only through the link it was read for, and gone
-- with that link (which goes with its membership and with the install).
create table if not exists public.slack_drafts (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.slack_links (id) on delete cascade,
  draft       jsonb not null,
  document    jsonb not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists slack_drafts_link_idx on public.slack_drafts (link_id);

alter table public.slack_drafts enable row level security;
revoke all privileges on table public.slack_drafts from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.slack_drafts to service_role;

-- Rollback:
-- drop table if exists public.slack_drafts;
-- alter table public.slack_installs drop column if exists scopes;
