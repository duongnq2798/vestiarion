import { AGENT_DECISION_ACTIONS } from "../../src/lib/agent/shadow-hold";
import { FOUNDING_ORG_ID } from "../../src/lib/dal/org-config";
import {
  assertShareable,
  exportShadowDecisions,
  SHADOW_DECISIONS_PATH,
  type ShadowLedgerRow,
  type ShadowVerdictRow,
} from "../../src/lib/quality-lab/shadow-export";

/**
 * The read and the write of `npm run quality-lab:shadow` (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-
 * design.md SX7), apart from its connection, so tests run it on a fake client and on PGlite with the real migrations.
 */

/** What the export needs of a pg client: `pg`'s `Client` and PGlite both are one. */
export interface ShadowExportClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Every agent decision on a bill made in shadow mode in the team's own workspaces on Arc testnet (SX1, SX2): the founding
 * workspace, by its id ($2), and those a platform team member created, as every reader that publishes rows picks them
 * (0087, 0100, 0134). Never a workspace with no creator otherwise: its creator deleted their account (0023), and it may
 * be a former customer's (0037). Never the guardrail fixture's entries, never a sample payee's bills. `side` names which
 * of the two each row is, so the mapping can refuse a row the filter should have left out, and check the founding one's
 * id itself.
 *
 * Of the payee's row, only what it says of the decision (SX3, SX4): its address on file, to tell whether a document's
 * pay-to differs, and whether that address changed since the decision, by its time or by a change the ledger recorded
 * after it (a mirror's leaves no time); how many whole hours before the decision it last changed, never when; and its
 * role, which nothing changes after the payee is added.
 */
export const SHADOW_ENTRIES_SQL = `
  select e.seq, e.ts, e.org_id, e.action, e.detail,
         case when o.id = $2::uuid then 'founding'
              when exists (select 1 from public.platform_team t where t.user_id = o.created_by) then 'team'
              else 'customers' end as side,
         c.address as address_on_file,
         coalesce(c.address_changed_at > e.ts, false)
           or exists (select 1 from public.ledger_entries a
                       where a.org_id = e.org_id and a.domain = 'compliance' and a.action = 'counterparty_address_changed'
                         and a.detail->>'counterpartyId' = e.detail->>'counterpartyId' and a.seq > e.seq) as address_changed_since,
         case when c.address_changed_at <= e.ts
              then floor(extract(epoch from (e.ts - c.address_changed_at)) / 3600)::int end as address_changed_hours_before,
         c.role as payee_role
    from public.ledger_entries e
    join public.orgs o on o.id = e.org_id
    join public.counterparties c on c.org_id = e.org_id and c.id::text = e.detail->>'counterpartyId'
   where e.actor = 'agent'
     and e.domain = 'ap'
     and e.action = any($1::text[])
     and e.detail->>'shadow' = 'true'
     and not (e.detail ? 'guardrailFixture')
     and not c.sample
     and o.network = 'arc-testnet'
     and (o.id = $2::uuid or exists (select 1 from public.platform_team t where t.user_id = o.created_by))
   order by e.ts, e.seq`;

/** The verdicts on those decisions: what was given, never its reason or who gave it. */
export const SHADOW_VERDICTS_SQL = `
  select v.org_id, v.entry_seq, v.verdict
    from public.decision_verdicts v
   where v.entry_seq = any($1::bigint[])`;

/**
 * Reads in one read-only transaction, maps through the allowlist, refuses anything that looks private, and only then
 * writes the file (SX3, SX6, SX7). Returns the line the script prints.
 */
export async function runShadowExport(input: {
  client: ShadowExportClient;
  write: (path: string, text: string) => void | Promise<void>;
  now?: Date;
}): Promise<string> {
  const { client, write } = input;
  await client.query("begin transaction read only");
  const entries = (await client.query(SHADOW_ENTRIES_SQL, [[...AGENT_DECISION_ACTIONS], FOUNDING_ORG_ID])).rows as ShadowLedgerRow[];
  const verdicts = (await client.query(SHADOW_VERDICTS_SQL, [entries.map((entry) => String(entry.seq))])).rows as ShadowVerdictRow[];
  await client.query("commit");

  const file = exportShadowDecisions(entries, verdicts, input.now ?? new Date());
  assertShareable(file);
  await write(SHADOW_DECISIONS_PATH, `${JSON.stringify(file, null, 2)}\n`);

  const count = (verdict: string | null) => file.decisions.filter((decision) => decision.verdict === verdict).length;
  const workspaces = new Set(file.decisions.map((decision) => decision.workspace)).size;
  return (
    `${file.decisions.length} shadow decisions from ${workspaces} workspaces: ${count("agree")} agreed, ${count("disagree")} disagreed, ` +
    `${count(null)} with no verdict. Wrote ${SHADOW_DECISIONS_PATH}`
  );
}
