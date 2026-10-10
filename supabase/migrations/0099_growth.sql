-- Growth tracking for the team: where workspaces come from, and how the leads the team finds by hand progress.
--
-- 1. growth_campaigns, growth_leads, growth_spend and growth_revenue: what the team records on /admin/growth. A lead is
--    a business the team found and may contact itself; nothing here contacts anyone, and approving a lead records a
--    decision only. growth_revenue counts as revenue only where kind = 'payment_received'.
-- 2. growth_lead_events: every change to a lead's stage, review status, campaign, workspace or source, and its
--    creation, written by the trigger growth_leads_log on growth_leads, so attribution and stage are never overwritten
--    without a trace. The events refuse update and delete (growth_lead_events_append_only), except the cascade when
--    their lead is deleted. A note and the person acting reach the trigger through two transaction-local settings,
--    growth.note and growth.by, which growth_update_lead and growth_import_leads set before they write; a write made
--    any other way (the org_id cleared when a workspace is deleted, say) is logged with neither.
-- 3. org_attribution: a workspace's first touch, the campaign tags of the visit that brought its creator (the vx_ft
--    cookie, src/lib/growth/attribution.ts), written once by record_org_attribution and never replaced.
-- 4. growth_team_member(p_user) gates the founder dashboard; growth_workspaces(p_since) lists the workspaces opened since
--    a day with how far each got, by 0089's definitions: a real bill is a payable whose counterparty is not sample
--    data, a decision is the agent's on one, a live payment is a confirmed Circle live payment of a real bill or a
--    milestone of a real contractor. A side is 'customers' when someone off platform_team created the workspace, else
--    'ours', as open_numbers and open_funnel split them (0037, 0089). No email or person's name leaves it.
--
-- Every table: row level security on, nothing for anon or authenticated, all for the service role. Every function:
-- security definer, an empty search_path, the service role only. Read by src/lib/growth (the dashboard) and the
-- onboarding action (record_org_attribution).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier function.

create table if not exists public.growth_campaigns (
  id              text primary key constraint growth_campaigns_id_check check (id ~ '^[a-z0-9-]{2,40}$'),
  name            text not null,
  strategies      smallint[] not null default '{}'
                  constraint growth_campaigns_strategies_check check (strategies <@ array[
                    1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,
                    26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50]::smallint[]),
  segment         text,
  offer           text,
  starts_on       date,
  ends_on         date,
  cash_budget_usd numeric(12, 2) constraint growth_campaigns_cash_budget_check check (cash_budget_usd >= 0),
  hour_budget     numeric(6, 1) constraint growth_campaigns_hour_budget_check check (hour_budget >= 0),
  status          text not null default 'planned'
                  constraint growth_campaigns_status_check check (status in ('planned', 'running', 'continue', 'iterate', 'pause', 'scale', 'stopped')),
  created_at      timestamptz not null default now()
);

create table if not exists public.growth_leads (
  id                  uuid primary key default gen_random_uuid(),
  business_name       text not null,
  company_url         text,
  sector              text,
  geography           text,
  size_estimate       text,
  size_uncertain      boolean not null default true,
  prospect_role       text,
  contact_channel     text constraint growth_leads_contact_channel_check
                      check (contact_channel in ('email', 'linkedin', 'x', 'telegram', 'discord', 'warm_intro', 'website_form', 'other')),
  -- A verified public handle or address, never invented.
  contact_handle      text,
  signal              text,
  evidence_url        text,
  evidence_date       date,
  inferred_pain       text,
  evidence_confidence text constraint growth_leads_evidence_confidence_check check (evidence_confidence in ('high', 'medium', 'low')),
  existing_solution   text,
  outreach_angle      text,
  draft_message       text,
  campaign_id         text references public.growth_campaigns (id) on delete set null,
  segment             text constraint growth_leads_segment_check
                      check (segment in ('software_agency', 'creative_agency', 'cloud_devops', 'web3_studio', 'stablecoin_ops', 'other')),
  source              text not null constraint growth_leads_source_check
                      check (source in ('warm_intro', 'signal_outbound', 'community', 'inbound', 'referral', 'content', 'directory', 'other')),
  source_detail       text,
  review_status       text not null default 'needs_review'
                      constraint growth_leads_review_status_check check (review_status in ('needs_review', 'approved_to_contact', 'rejected')),
  stage               text not null default 'discovered' constraint growth_leads_stage_check check (stage in (
                        'discovered', 'verified', 'qualified', 'contact_approved', 'contacted', 'replied', 'conversation',
                        'trial_started', 'workspace_created', 'real_invoice_reviewed', 'second_invoice', 'live_payment',
                        'pricing_conversation', 'paid_pilot', 'paying_customer', 'disqualified', 'lost')),
  org_id              uuid references public.orgs (id) on delete set null,
  -- The lower-case host of company_url without www., else the lower-case trimmed business name (src/lib/growth/csv.ts).
  dedupe_key          text not null constraint growth_leads_dedupe_key_key unique,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists growth_leads_org on public.growth_leads (org_id) where org_id is not null;
create index if not exists growth_leads_campaign on public.growth_leads (campaign_id) where campaign_id is not null;

create table if not exists public.growth_lead_events (
  id        bigint generated always as identity primary key,
  lead_id   uuid not null references public.growth_leads (id) on delete cascade,
  field     text not null constraint growth_lead_events_field_check
            check (field in ('stage', 'review_status', 'campaign_id', 'org_id', 'source', 'created')),
  old_value text,
  new_value text,
  note      text,
  -- The team member who made the change, as an id only; no foreign key, so the trail outlives an account as the ledger does.
  by_user   uuid,
  at        timestamptz not null default now()
);

create index if not exists growth_lead_events_lead on public.growth_lead_events (lead_id, at);

create table if not exists public.growth_spend (
  id            bigint generated always as identity primary key,
  campaign_id   text references public.growth_campaigns (id) on delete cascade,
  spent_on      date not null,
  usd           numeric(12, 2) not null default 0 constraint growth_spend_usd_check check (usd >= 0),
  founder_hours numeric(6, 1) not null default 0 constraint growth_spend_founder_hours_check check (founder_hours >= 0),
  note          text,
  created_at    timestamptz not null default now()
);

create table if not exists public.growth_revenue (
  id          bigint generated always as identity primary key,
  lead_id     uuid references public.growth_leads (id) on delete set null,
  org_id      uuid references public.orgs (id) on delete set null,
  kind        text not null constraint growth_revenue_kind_check
              check (kind in ('pricing_discussed', 'willingness_stated', 'pilot_agreed', 'invoice_issued', 'payment_received')),
  amount      numeric(12, 2),
  currency    text,
  occurred_on date not null,
  reference   text,
  note        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.org_attribution (
  org_id        uuid primary key references public.orgs (id) on delete cascade,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text,
  ref           text,
  landing_path  text,
  referrer_host text,
  first_seen_at timestamptz,
  recorded_at   timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['growth_campaigns', 'growth_leads', 'growth_lead_events', 'growth_spend', 'growth_revenue', 'org_attribution'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated', t);
    execute format('grant all privileges on table public.%I to service_role', t);
  end loop;
end
$$;

-- updated_at follows every change to a lead.
create or replace function public.growth_leads_touch() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists growth_leads_touch on public.growth_leads;
create trigger growth_leads_touch before update on public.growth_leads
  for each row execute function public.growth_leads_touch();

-- One event per tracked field a write changed, and one 'created' event (its new_value the stage) when a lead is added.
create or replace function public.growth_leads_log() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(current_setting('growth.note', true), '');
  v_by   uuid := nullif(current_setting('growth.by', true), '')::uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.growth_lead_events (lead_id, field, old_value, new_value, note, by_user)
    values (new.id, 'created', null, new.stage, v_note, v_by);
    return null;
  end if;
  if new.stage is distinct from old.stage then
    insert into public.growth_lead_events (lead_id, field, old_value, new_value, note, by_user)
    values (new.id, 'stage', old.stage, new.stage, v_note, v_by);
  end if;
  if new.review_status is distinct from old.review_status then
    insert into public.growth_lead_events (lead_id, field, old_value, new_value, note, by_user)
    values (new.id, 'review_status', old.review_status, new.review_status, v_note, v_by);
  end if;
  if new.campaign_id is distinct from old.campaign_id then
    insert into public.growth_lead_events (lead_id, field, old_value, new_value, note, by_user)
    values (new.id, 'campaign_id', old.campaign_id, new.campaign_id, v_note, v_by);
  end if;
  if new.org_id is distinct from old.org_id then
    insert into public.growth_lead_events (lead_id, field, old_value, new_value, note, by_user)
    values (new.id, 'org_id', old.org_id::text, new.org_id::text, v_note, v_by);
  end if;
  if new.source is distinct from old.source then
    insert into public.growth_lead_events (lead_id, field, old_value, new_value, note, by_user)
    values (new.id, 'source', old.source, new.source, v_note, v_by);
  end if;
  return null;
end;
$$;

drop trigger if exists growth_leads_log on public.growth_leads;
create trigger growth_leads_log after insert or update on public.growth_leads
  for each row execute function public.growth_leads_log();

-- The trail is append-only. The one delete allowed is the cascade from its lead's own deletion: by the time the
-- cascade reaches an event, its lead is gone.
create or replace function public.growth_lead_events_append_only() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.growth_leads l where l.id = old.lead_id) then
    return old;
  end if;
  raise exception 'growth_lead_events is append-only';
end;
$$;

drop trigger if exists growth_lead_events_append_only on public.growth_lead_events;
create trigger growth_lead_events_append_only before update or delete on public.growth_lead_events
  for each row execute function public.growth_lead_events_append_only();

create or replace function public.growth_lead_events_no_truncate() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'growth_lead_events is append-only';
end;
$$;

drop trigger if exists growth_lead_events_no_truncate on public.growth_lead_events;
create trigger growth_lead_events_no_truncate before truncate on public.growth_lead_events
  for each statement execute function public.growth_lead_events_no_truncate();

-- Whether a person is on the team, for the founder dashboard's gate.
create or replace function public.growth_team_member(p_user uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_team t where t.user_id = p_user)
$$;

-- Changes a lead's tracked fields named in p_changes (stage, review_status, campaign_id, org_id, source; a key absent is
-- left as it is, a key with null clears it), with the note and the person the trigger logs each change with. Returns
-- whether the lead exists.
create or replace function public.growth_update_lead(p_lead uuid, p_changes jsonb, p_note text, p_by uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('growth.note', coalesce(p_note, ''), true);
  perform set_config('growth.by', coalesce(p_by::text, ''), true);
  update public.growth_leads l
     set stage         = case when p_changes ? 'stage' then p_changes ->> 'stage' else l.stage end,
         review_status = case when p_changes ? 'review_status' then p_changes ->> 'review_status' else l.review_status end,
         campaign_id   = case when p_changes ? 'campaign_id' then p_changes ->> 'campaign_id' else l.campaign_id end,
         org_id        = case when p_changes ? 'org_id' then (p_changes ->> 'org_id')::uuid else l.org_id end,
         source        = case when p_changes ? 'source' then p_changes ->> 'source' else l.source end
   where l.id = p_lead;
  perform set_config('growth.note', '', true);
  perform set_config('growth.by', '', true);
  return found;
end;
$$;

-- Adds the leads in p_rows (an array of objects keyed by column), each one whose dedupe_key is not taken; an existing
-- lead is never overwritten. Returns the dedupe keys added.
create or replace function public.growth_import_leads(p_rows jsonb, p_by uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added jsonb;
begin
  perform set_config('growth.note', 'imported', true);
  perform set_config('growth.by', coalesce(p_by::text, ''), true);
  with added as (
    insert into public.growth_leads (
      business_name, company_url, sector, geography, size_estimate, size_uncertain, prospect_role, contact_channel,
      contact_handle, signal, evidence_url, evidence_date, inferred_pain, evidence_confidence, existing_solution,
      outreach_angle, draft_message, campaign_id, segment, source, source_detail, notes, stage, review_status, dedupe_key
    )
    select r.business_name, r.company_url, r.sector, r.geography, r.size_estimate, coalesce(r.size_uncertain, true),
           r.prospect_role, r.contact_channel, r.contact_handle, r.signal, r.evidence_url, r.evidence_date,
           r.inferred_pain, r.evidence_confidence, r.existing_solution, r.outreach_angle, r.draft_message,
           r.campaign_id, r.segment, r.source, r.source_detail, r.notes, coalesce(r.stage, 'discovered'),
           'needs_review', r.dedupe_key
      from jsonb_to_recordset(p_rows) as r (
        business_name text, company_url text, sector text, geography text, size_estimate text, size_uncertain boolean,
        prospect_role text, contact_channel text, contact_handle text, signal text, evidence_url text,
        evidence_date date, inferred_pain text, evidence_confidence text, existing_solution text,
        outreach_angle text, draft_message text, campaign_id text, segment text, source text, source_detail text,
        notes text, stage text, dedupe_key text
      )
     where r.stage is null or r.stage in ('discovered', 'verified')
    on conflict (dedupe_key) do nothing
    returning dedupe_key
  )
  select coalesce(jsonb_agg(added.dedupe_key), '[]'::jsonb) into v_added from added;
  perform set_config('growth.note', '', true);
  perform set_config('growth.by', '', true);
  return v_added;
end;
$$;

-- A workspace's first touch: written once, never replaced. Each value is cut to 100 characters again here, whatever the
-- caller sent; a first_seen_at that is not an ISO instant in UTC is left out. Returns whether this call wrote it.
create or replace function public.record_org_attribution(p_org uuid, p_attr jsonb) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen  timestamptz;
  v_count int;
begin
  -- An ISO instant in UTC only: Postgres would also read words such as 'yesterday' as a time.
  if (p_attr ->> 'first_seen_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
    begin
      v_seen := (p_attr ->> 'first_seen_at')::timestamptz;
    exception when others then
      v_seen := null;
    end;
  end if;
  insert into public.org_attribution
    (org_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, ref, landing_path, referrer_host, first_seen_at)
  values (
    p_org,
    left(nullif(p_attr ->> 'utm_source', ''), 100),
    left(nullif(p_attr ->> 'utm_medium', ''), 100),
    left(nullif(p_attr ->> 'utm_campaign', ''), 100),
    left(nullif(p_attr ->> 'utm_content', ''), 100),
    left(nullif(p_attr ->> 'utm_term', ''), 100),
    left(nullif(p_attr ->> 'ref', ''), 100),
    left(nullif(p_attr ->> 'landing_path', ''), 100),
    left(nullif(p_attr ->> 'referrer_host', ''), 100),
    v_seen
  )
  on conflict (org_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- One object per workspace opened since p_since (all of them when null), newest first: how far it got, by 0089's
-- definitions, with its first touch and the counts the dashboard needs. Workspace ids and slugs only; no person.
create or replace function public.growth_workspaces(p_since timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  ws as (
    select o.id, o.slug, o.network, o.mode, o.created_at,
           case when o.created_by is not null
                 and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                then 'customers' else 'ours' end as side
      from public.orgs o
     where o.created_at >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  real_bills as (
    select i.id, i.org_id, i.created_at
      from public.invoices i
      join public.counterparties c on c.id = i.counterparty_id
     where i.direction = 'payable' and not c.sample and i.org_id in (select id from ws)
  ),
  bills as (
    select b.org_id, min(b.created_at) as first_at, count(*) as n
      from real_bills b
     group by b.org_id
  ),
  bills_7d as (
    select b.org_id, count(*) as n
      from real_bills b
      join bills f on f.org_id = b.org_id
     where b.created_at < f.first_at + interval '7 days'
     group by b.org_id
  ),
  decisions as (
    select e.org_id, min(e.ts) as first_at
      from public.ledger_entries e
     where e.actor = 'agent'
       and e.action in ('ap_pay', 'ap_schedule', 'ap_hold', 'ap_flag_fraud', 'ap_request_info')
       and e.org_id in (select id from ws)
       and exists (select 1 from real_bills b where b.id::text = e.detail ->> 'invoiceId' and b.org_id = e.org_id)
     group by e.org_id
  ),
  verdicts as (
    select v.org_id, count(*) as given, count(*) filter (where v.verdict = 'agree') as agreed
      from public.decision_verdicts v
     where v.org_id in (select id from ws)
     group by v.org_id
  ),
  paid as (
    select pi.org_id, count(*) as n, coalesce(sum(pi.amount) filter (where pi.token = 'USDC'), 0) as usdc
      from public.payment_intents pi
     where pi.provider = 'circle'
       and pi.provider_mode = 'live'
       and pi.status = 'confirmed'
       and pi.org_id in (select id from ws)
       and (
         (pi.source_type = 'invoice' and exists (select 1 from real_bills b where b.id = pi.source_id and b.org_id = pi.org_id))
         or (
           pi.source_type = 'milestone'
           and exists (
             select 1
               from public.milestones m
               join public.counterparties c on c.id = m.contractor_id
              where m.id = pi.source_id and m.org_id = pi.org_id and not c.sample
           )
         )
       )
     group by pi.org_id
  ),
  members as (
    select m.org_id, count(*) as n from public.memberships m where m.org_id in (select id from ws) group by m.org_id
  ),
  -- The lead the team linked to the workspace, the earliest added when there is more than one.
  linked as (
    select distinct on (l.org_id) l.org_id, l.id, l.source, l.campaign_id
      from public.growth_leads l
     where l.org_id in (select id from ws)
     order by l.org_id, l.created_at, l.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'orgId',                  w.id,
    'slug',                   w.slug,
    'network',                w.network,
    'side',                   w.side,
    'createdAt',              w.created_at,
    'mode',                   w.mode,
    'shadow',                 exists (select 1 from public.shadow_modes s where s.org_id = w.id),
    'attribution',            (select jsonb_build_object(
                                 'utmSource', a.utm_source, 'utmMedium', a.utm_medium, 'utmCampaign', a.utm_campaign,
                                 'utmContent', a.utm_content, 'utmTerm', a.utm_term, 'ref', a.ref,
                                 'landingPath', a.landing_path, 'referrerHost', a.referrer_host, 'firstSeenAt', a.first_seen_at)
                                 from public.org_attribution a where a.org_id = w.id),
    'lead',                   (select jsonb_build_object('id', k.id, 'source', k.source, 'campaignId', k.campaign_id)
                                 from linked k where k.org_id = w.id),
    'firstRealBillAt',        b.first_at,
    'realBills',              coalesce(b.n, 0),
    'realBillsWithin7dOfFirst', coalesce(b7.n, 0),
    'firstDecisionAt',        d.first_at,
    'verdictsGiven',          coalesce(v.given, 0),
    'verdictsAgreed',         coalesce(v.agreed, 0),
    'livePayments',           coalesce(p.n, 0),
    'liveUsdc',               coalesce(p.usdc, 0),
    'members',                coalesce(m.n, 0)
  ) order by w.created_at desc, w.id), '[]'::jsonb)
    from ws w
    left join bills b on b.org_id = w.id
    left join bills_7d b7 on b7.org_id = w.id
    left join decisions d on d.org_id = w.id
    left join verdicts v on v.org_id = w.id
    left join paid p on p.org_id = w.id
    left join members m on m.org_id = w.id;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.growth_leads_touch()', 'public.growth_leads_log()', 'public.growth_lead_events_append_only()',
    'public.growth_lead_events_no_truncate()', 'public.growth_team_member(uuid)',
    'public.growth_update_lead(uuid, jsonb, text, uuid)', 'public.growth_import_leads(jsonb, uuid)',
    'public.record_org_attribution(uuid, jsonb)', 'public.growth_workspaces(timestamptz)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- Down (by hand):
--   drop function if exists public.growth_workspaces(timestamptz);
--   drop function if exists public.record_org_attribution(uuid, jsonb);
--   drop function if exists public.growth_import_leads(jsonb, uuid);
--   drop function if exists public.growth_update_lead(uuid, jsonb, text, uuid);
--   drop function if exists public.growth_team_member(uuid);
--   drop table if exists public.org_attribution, public.growth_revenue, public.growth_spend, public.growth_lead_events,
--     public.growth_leads, public.growth_campaigns;
--   drop function if exists public.growth_lead_events_no_truncate(), public.growth_lead_events_append_only(),
--     public.growth_leads_log(), public.growth_leads_touch();
