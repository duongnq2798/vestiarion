-- Notifications (docs/superpowers/specs/2026-09-29-notifications-design.md, N4, N6).
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- N6: each member decides whether the digest reaches them. On by default.
alter table public.memberships
  add column if not exists notify_email boolean not null default true;

-- N4: when the members who can decide an invoice were last told it waits.
-- An escalation after this (escalated_at > notified_at) makes it news again.
alter table public.invoices
  add column if not exists notified_at timestamptz;
