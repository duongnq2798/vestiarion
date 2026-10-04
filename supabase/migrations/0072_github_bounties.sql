-- Bounties from a pull request comment (docs/superpowers/specs/2026-10-04-github-bounties-design.md B6, B7): the bounty
-- a maintainer attached to a pull request with `/bounty`, the counterparty it pays and the milestone it made.
-- Re-runnable, as every migration here: db:migrate applies them all in order.
--
-- A platform table, like github_installations (0071): RLS is on, no policy exists for any browser or tenant role, and
-- only the service role reads or writes it. Its counterparty and milestone are its own workspace's, through composite
-- keys, as payee_links' counterparty is (0058).

-- A milestone's workspace and id, as a pair another table can point at (0019 gave counterparties theirs).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'milestones_org_id_id_key' and conrelid = 'public.milestones'::regclass) then
    alter table public.milestones add constraint milestones_org_id_id_key unique (org_id, id);
  end if;
end $$;

create table if not exists public.github_bounties (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  installation_id    bigint not null
                       constraint github_bounties_installation_id_check check (installation_id > 0),
  -- owner/name in lower case: GitHub's names are case-insensitive.
  repository         text not null
                       constraint github_bounties_repository_check check (repository ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}$'),
  pull_number        integer not null
                       constraint github_bounties_pull_number_check check (pull_number > 0),
  pull_url           text not null
                       constraint github_bounties_pull_url_check check (pull_url ~ '^https://github\.com/'),
  -- The pull request's author, who is paid (B7): a GitHub login as GitHub writes it, matched in lower case.
  author_login       text not null
                       constraint github_bounties_author_login_check check (author_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  -- Null while the bounty is claimed and its counterparty and milestone are being made: the claim holds the pull
  -- request first, so two comments at once never make two milestones, and is removed if making them fails.
  counterparty_id    uuid,
  milestone_id       uuid,
  amount             numeric(20, 6) not null
                       constraint github_bounties_amount_check check (amount > 0),
  -- Who attached it, as GitHub named them, and the comment that did.
  attached_by_login  text not null
                       constraint github_bounties_attached_by_login_check check (attached_by_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  comment_id         bigint not null
                       constraint github_bounties_comment_id_check check (comment_id > 0),
  comment_url        text not null
                       constraint github_bounties_comment_url_check check (comment_url ~ '^https://github\.com/'),
  created_at         timestamptz not null default now(),
  constraint github_bounties_pull_key unique (org_id, repository, pull_number),
  -- A comment attaches at most one bounty: a delivery GitHub sends again does nothing twice.
  constraint github_bounties_comment_key unique (comment_id),
  constraint github_bounties_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade,
  constraint github_bounties_milestone_fkey foreign key (org_id, milestone_id)
    references public.milestones (org_id, id) on delete cascade
);

-- A contributor's earlier bounties in a workspace, to pay them as the same counterparty (B7).
create index if not exists github_bounties_author_idx on public.github_bounties (org_id, lower(author_login));

alter table public.github_bounties enable row level security;
revoke all privileges on table public.github_bounties from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.github_bounties to service_role;

-- Rollback (loses every bounty's record; their milestones and counterparties stay):
-- drop table if exists public.github_bounties;
-- alter table public.milestones drop constraint if exists milestones_org_id_id_key;
