-- Slack (docs/superpowers/specs/2026-10-03-slack-design.md §5): a workspace's Slack install, its members' links to their
-- own Slack accounts, and the one-time codes that make a link. Re-runnable, as every migration here: db:migrate applies
-- them all in order.
--
-- Platform tables, like telegram_links (0064): RLS is on, no policy exists for any browser or tenant role, and only the
-- service role reads or writes them. The bot token and the incoming webhook's URL are stored only as envelopes under
-- the platform master key (S3); a code is stored only as its SHA-256 (S4). One Slack team serves one workspace, and a
-- workspace has one install. A link belongs to a membership and to the install, and goes with either.

create table if not exists public.slack_installs (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null constraint slack_installs_org_id_key unique
                                 references public.orgs (id) on delete cascade,
  team_id               text not null constraint slack_installs_team_id_key unique
                                 constraint slack_installs_team_id_check check (team_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  team_name             text constraint slack_installs_team_name_check check (team_name is null or char_length(team_name) between 1 and 200),
  app_id                text not null constraint slack_installs_app_id_check check (app_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  bot_user_id           text constraint slack_installs_bot_user_id_check check (bot_user_id is null or bot_user_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  bot_token_enc         jsonb not null,
  webhook_url_enc       jsonb not null,
  channel_id            text not null constraint slack_installs_channel_id_check check (channel_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  channel_name          text constraint slack_installs_channel_name_check check (channel_name is null or char_length(channel_name) between 1 and 200),
  installed_by          uuid references auth.users (id) on delete set null,
  installed_at          timestamptz not null default now(),
  -- The last ledger entry the channel was told about (S7).
  notified_seq          bigint not null default 0,
  -- Null: deciding payments from Slack is off. Otherwise the most a payment approved there may be, in USDC (S8).
  decisions_limit_usdc  numeric(20,6)
                         constraint slack_installs_decisions_limit_check check (decisions_limit_usdc is null or decisions_limit_usdc > 0),
  constraint slack_installs_org_team_key unique (org_id, team_id)
);

create table if not exists public.slack_links (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  user_id        uuid not null,
  team_id        text not null,
  slack_user_id  text not null constraint slack_links_slack_user_id_check check (slack_user_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  linked_at      timestamptz not null default now(),
  constraint slack_links_member_key unique (org_id, user_id),
  constraint slack_links_slack_user_key unique (team_id, slack_user_id),
  constraint slack_links_membership_fkey foreign key (org_id, user_id)
    references public.memberships (org_id, user_id) on delete cascade,
  constraint slack_links_install_fkey foreign key (org_id, team_id)
    references public.slack_installs (org_id, team_id) on delete cascade
);

-- A code `/vestiarion connect` gave one Slack account, waiting for that person to sign in and connect it (S4).
create table if not exists public.slack_link_requests (
  id               uuid primary key default gen_random_uuid(),
  team_id          text not null constraint slack_link_requests_team_id_check check (team_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  slack_user_id    text not null constraint slack_link_requests_slack_user_id_check check (slack_user_id ~ '^[A-Z][A-Z0-9]{1,31}$'),
  slack_user_name  text constraint slack_link_requests_slack_user_name_check check (slack_user_name is null or char_length(slack_user_name) between 1 and 100),
  code_hash        text not null constraint slack_link_requests_code_hash_key unique
                            constraint slack_link_requests_code_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz
);

create index if not exists slack_link_requests_expires_idx on public.slack_link_requests (expires_at);

alter table public.slack_installs enable row level security;
alter table public.slack_links enable row level security;
alter table public.slack_link_requests enable row level security;
revoke all privileges on table public.slack_installs from anon, authenticated, vestiarion_tenant;
revoke all privileges on table public.slack_links from anon, authenticated, vestiarion_tenant;
revoke all privileges on table public.slack_link_requests from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.slack_installs to service_role;
grant all privileges on table public.slack_links to service_role;
grant all privileges on table public.slack_link_requests to service_role;

-- Uses a code up and links its Slack account to a member, in one transaction (S4): only an unused, unexpired code,
-- only for the workspace that installed the code's Slack team, and only for one of its members. A link either side
-- already had is replaced, so a member has one Slack account and a Slack account one member. No row otherwise, and
-- then the code is left unused.
create or replace function public.slack_link_member(p_code_hash text, p_org_id uuid, p_user_id uuid)
returns setof public.slack_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team       text;
  v_slack_user text;
  v_id         uuid;
begin
  update public.slack_link_requests r
     set used_at = now()
   where r.code_hash = p_code_hash
     and r.used_at is null
     and r.expires_at > now()
     and exists (select 1 from public.slack_installs i where i.org_id = p_org_id and i.team_id = r.team_id)
     and exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_user_id)
  returning r.team_id, r.slack_user_id into v_team, v_slack_user;
  if v_team is null then
    return;
  end if;

  delete from public.slack_links
   where (org_id = p_org_id and user_id = p_user_id)
      or (team_id = v_team and slack_user_id = v_slack_user);

  insert into public.slack_links (org_id, user_id, team_id, slack_user_id)
  values (p_org_id, p_user_id, v_team, v_slack_user)
  returning id into v_id;

  return query select * from public.slack_links where id = v_id;
end;
$$;

revoke execute on function public.slack_link_member(text, uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.slack_link_member(text, uuid, uuid) to service_role;

-- Rollback:
-- drop function if exists public.slack_link_member(text, uuid, uuid);
-- drop table if exists public.slack_link_requests;
-- drop table if exists public.slack_links;
-- drop table if exists public.slack_installs;
