-- GitHub (docs/superpowers/specs/2026-10-04-github-app-design.md G3, G4, G6): the GitHub App installations a workspace
-- connected, and the comment a paid pull request got. Re-runnable, as every migration here: db:migrate applies them all
-- in order.
--
-- A platform table, like slack_installs (0067): RLS is on, no policy exists for any browser or tenant role, and only the
-- service role reads or writes it. An installation is connected by a person GitHub itself said could reach it (G2), and
-- may be connected to more than one workspace (G3). Nothing secret is stored: tokens are made for each run (G7).

create table if not exists public.github_installations (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.orgs (id) on delete cascade,
  installation_id       bigint not null
                          constraint github_installations_installation_id_check check (installation_id > 0),
  -- A GitHub login: letters, digits and single dashes, at most 39 characters.
  account_login         text not null
                          constraint github_installations_account_login_check check (account_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  account_type          text not null
                          constraint github_installations_account_type_check check (account_type in ('User', 'Organization', 'Enterprise')),
  repository_selection  text not null
                          constraint github_installations_repository_selection_check check (repository_selection in ('all', 'selected')),
  connected_by          uuid references auth.users (id) on delete set null,
  connected_at          timestamptz not null default now(),
  constraint github_installations_org_installation_key unique (org_id, installation_id)
);

-- A repository's installation is looked up on GitHub, then matched to the workspaces that connected it.
create index if not exists github_installations_installation_idx on public.github_installations (installation_id);

alter table public.github_installations enable row level security;
revoke all privileges on table public.github_installations from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.github_installations to service_role;

-- The comment a confirmed milestone payment got on its pull request (G4): claimed before it is posted, released if
-- posting fails, and its link kept once it is posted.
alter table public.payment_intents add column if not exists pr_comment_at timestamptz;
alter table public.payment_intents add column if not exists pr_comment_url text;
alter table public.payment_intents drop constraint if exists payment_intents_pr_comment_url_check;
alter table public.payment_intents add constraint payment_intents_pr_comment_url_check
  check (pr_comment_url is null or pr_comment_url ~ '^https://github\.com/');

comment on column public.payment_intents.pr_comment_at is
  'When the comment on the paid pull request was claimed (GitHub App design G4); null until then, or after a failed post.';
comment on column public.payment_intents.pr_comment_url is
  'The comment GitHub made for the paid pull request (GitHub App design G4), once it is posted.';

-- Rollback (loses every connection and the comment links):
-- alter table public.payment_intents drop constraint if exists payment_intents_pr_comment_url_check;
-- alter table public.payment_intents drop column if exists pr_comment_url, drop column if exists pr_comment_at;
-- drop table if exists public.github_installations;
