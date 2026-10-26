import { AGENT_DECISION_ACTIONS } from "../../src/lib/agent/shadow-hold";
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
 * workspace (no creator) and those a platform team member created, as open_verdicts (0086) splits them; never the
 * guardrail fixture's entries, never a sample payee's bills. `side` repeats the split, so the mapping can refuse a row
 * the filter should have left out. The payee's address on file is read only to tell whether a document's pay-to differs.
 */
export const SHADOW_ENTRIES_SQL = `
  select e.seq, e.ts, e.org_id, e.action, e.detail,
         case when o.created_by is not null and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
              then 'customers' else 'ours' end as side,
         c.address as address_on_file
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
     and (o.created_by is null or exists (select 1 from public.platform_team t where t.user_id = o.created_by))
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
  const entries = (await client.query(SHADOW_ENTRIES_SQL, [[...AGENT_DECISION_ACTIONS]])).rows as ShadowLedgerRow[];
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
