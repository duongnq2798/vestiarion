-- Telegram (docs/superpowers/specs/2026-10-03-telegram-bot-design.md §5): a member's own Telegram chat, connected to
-- their membership of a workspace by a one-time code. Re-runnable, as every migration here: db:migrate applies them
-- all in order.
--
-- Platform tables, like api_keys (0027): RLS is on, no policy exists for any browser or tenant role, and only the
-- service role reads or writes them. A code and a link belong to a membership and go with it (R6); a draft belongs
-- to its link. The code itself is never stored, only its SHA-256 as hex (R4).

create table if not exists public.telegram_link_codes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  user_id     uuid not null,
  code_hash   text not null constraint telegram_link_codes_code_hash_key unique
                         constraint telegram_link_codes_code_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  constraint telegram_link_codes_membership_fkey foreign key (org_id, user_id)
    references public.memberships (org_id, user_id) on delete cascade
);

create index if not exists telegram_link_codes_member_idx on public.telegram_link_codes (org_id, user_id);

-- One chat per membership (unique), one active workspace per chat (the partial index): commands and invoices go to the
-- active one, decisions come from every one (R5). `notified_seq` is the last ledger entry the chat was told about (R8).
create table if not exists public.telegram_links (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  user_id       uuid not null,
  chat_id       bigint not null,
  username      text constraint telegram_links_username_check check (username is null or char_length(username) between 1 and 64),
  active        boolean not null default true,
  notified_seq  bigint not null default 0,
  linked_at     timestamptz not null default now(),
  constraint telegram_links_member_key unique (org_id, user_id),
  constraint telegram_links_membership_fkey foreign key (org_id, user_id)
    references public.memberships (org_id, user_id) on delete cascade
);

create index if not exists telegram_links_chat_idx on public.telegram_links (chat_id);
create unique index if not exists telegram_links_active_chat on public.telegram_links (chat_id) where active;

-- An invoice read in the chat, waiting for the member's tap; used once, for an hour (R10).
create table if not exists public.telegram_drafts (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.telegram_links (id) on delete cascade,
  draft       jsonb not null,
  document    jsonb not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists telegram_drafts_link_idx on public.telegram_drafts (link_id);

alter table public.telegram_link_codes enable row level security;
alter table public.telegram_links enable row level security;
alter table public.telegram_drafts enable row level security;
revoke all privileges on table public.telegram_link_codes from anon, authenticated, vestiarion_tenant;
revoke all privileges on table public.telegram_links from anon, authenticated, vestiarion_tenant;
revoke all privileges on table public.telegram_drafts from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.telegram_link_codes to service_role;
grant all privileges on table public.telegram_links to service_role;
grant all privileges on table public.telegram_drafts to service_role;

-- Claims a code and links the chat, in one transaction (R4, R5): the code is used once, before it expires; the
-- membership's link is made or moved to this chat and becomes the chat's active one; its cursor starts at the
-- workspace's ledger head, so the chat is never sent the past. No row when the code is unknown, used or expired.
-- The advisory lock serialises the chat, so two claims at once cannot both leave an active link.
create or replace function public.telegram_claim_code(p_code_hash text, p_chat_id bigint, p_username text)
returns setof public.telegram_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_head bigint;
  v_id   uuid;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_telegram_chat:' || p_chat_id::text));

  update public.telegram_link_codes
     set used_at = now()
   where code_hash = p_code_hash and used_at is null and expires_at > now()
  returning org_id, user_id into v_org, v_user;
  if v_org is null then
    return;
  end if;

  select coalesce(max(seq), 0) into v_head from public.ledger_entries where org_id = v_org;

  update public.telegram_links
     set active = false
   where chat_id = p_chat_id and active and not (org_id = v_org and user_id = v_user);

  insert into public.telegram_links (org_id, user_id, chat_id, username, active, notified_seq, linked_at)
  values (v_org, v_user, p_chat_id, p_username, true, v_head, now())
  on conflict on constraint telegram_links_member_key do update
     set chat_id = excluded.chat_id,
         username = excluded.username,
         active = true,
         notified_seq = excluded.notified_seq,
         linked_at = excluded.linked_at
  returning id into v_id;

  return query select * from public.telegram_links where id = v_id;
end;
$$;

-- Makes one of the chat's links its active one (R5). No row when the link is not this chat's.
create or replace function public.telegram_activate(p_chat_id bigint, p_link_id uuid)
returns setof public.telegram_links
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_telegram_chat:' || p_chat_id::text));

  if not exists (select 1 from public.telegram_links where id = p_link_id and chat_id = p_chat_id) then
    return;
  end if;
  update public.telegram_links set active = false where chat_id = p_chat_id and active and id <> p_link_id;
  update public.telegram_links set active = true where id = p_link_id;
  return query select * from public.telegram_links where id = p_link_id;
end;
$$;

revoke execute on function public.telegram_claim_code(text, bigint, text) from public, anon, authenticated, vestiarion_tenant;
revoke execute on function public.telegram_activate(bigint, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.telegram_claim_code(text, bigint, text) to service_role;
grant execute on function public.telegram_activate(bigint, uuid) to service_role;

-- Rollback:
-- drop function if exists public.telegram_activate(bigint, uuid);
-- drop function if exists public.telegram_claim_code(text, bigint, text);
-- drop table if exists public.telegram_drafts;
-- drop table if exists public.telegram_links;
-- drop table if exists public.telegram_link_codes;
