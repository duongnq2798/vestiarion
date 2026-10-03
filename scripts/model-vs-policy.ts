/**
 * Prints the numbers behind the research note "When the model and the
 * written policy disagree" (content/docs/research/model-vs-policy.mdx), read
 * from the database the app runs on.
 *
 *   npm run research:model-vs-policy
 *   npm run research:model-vs-policy -- --from 2026-10-01T05:48:00Z [--to …]   one window (from inclusive, to exclusive)
 *
 * Read-only: the query runs in a read-only transaction. Needs SUPABASE_PROJECT_ID and
 * SUPABASE_DATABASE_PASSWORD (or SUPABASE_DB_URL), as `npm run db:migrate`
 * does. A customer's workspace is never named and its entries' summaries are
 * never printed: it is counted, as /open counts it.
 */
import { config } from "dotenv";
import { Client } from "pg";
import {
  agreementOf,
  peopleMarkdown,
  summarizeDecisions,
  summarizePeople,
  summaryMarkdown,
  within,
  type PersonDecision,
  type RecordedDecision,
} from "../src/lib/research/model-vs-policy";

config({ path: [".env.local", ".env"], quiet: true });

function connectionString(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const ref = process.env.SUPABASE_PROJECT_ID;
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!ref || !password) throw new Error("Set SUPABASE_PROJECT_ID and SUPABASE_DATABASE_PASSWORD (or SUPABASE_DB_URL) in .env.local");
  const region = process.env.SUPABASE_REGION ?? "us-east-1";
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

// Every entry an agent decision wrote, with the written policy's answer beside
// it. "Ours" is /open's rule (0040): a workspace whose creator is not on the
// platform team is a customer's.
const DECISIONS = `
  select e.seq, e.ts, e.domain, e.summary,
         case when o.created_by is not null and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
              then 'customers' else 'ours' end as side,
         o.slug,
         e.detail->>'decisionMode' as mode,
         -- The model's own choice: where code limited a treasury move, the entry keeps it apart (treasury bounds R1–R3).
         coalesce(e.detail->'boundedByCode'->'chosen'->>'action', e.detail->'decision'->>'action') as model_action,
         e.detail->'referenceDecision'->>'action' as policy_action,
         coalesce(e.detail->'boundedByCode'->'chosen'->>'amount', e.detail->'decision'->>'amount') as model_amount,
         e.detail->'referenceDecision'->>'amount' as policy_amount,
         e.detail->'agreedWithReference' as agreed,
         e.detail->>'guardrailRule' as guardrail_rule,
         coalesce((e.detail->>'guardrailBlocked')::boolean, false) as guardrail_blocked,
         e.detail->'decision'->>'confidence' as confidence,
         i.status as outcome
    from public.ledger_entries e
    join public.orgs o on o.id = e.org_id
    left join public.invoices i on i.id = (e.detail->>'invoiceId')::uuid and i.org_id = e.org_id
   where e.actor = 'agent' and e.detail ? 'decisionMode'
     -- The guardrail fixture's planted verdicts are not the model's (scripts/guardrail-fixture.ts).
     and not (e.detail ? 'guardrailFixture')
   order by e.seq`;

// What people decided about what the agent left them, each beside the agent's last decision on the same invoice or
// milestone before it (I2). Screening reviews and limit proposals have no such decision.
const PEOPLE = `
  select p.seq, p.ts, p.action,
         case when o.created_by is not null and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
              then 'customers' else 'ours' end as side,
         o.slug,
         a.agent_action,
         a.policy_action,
         coalesce(a.refused, false) as refused,
         case when p.action = 'screening_match_dismissed'
              then coalesce(jsonb_array_length(case when jsonb_typeof(p.detail->'matchedEntities') = 'array' then p.detail->'matchedEntities' end), 1)
              else 0 end as dismissed
    from public.ledger_entries p
    join public.orgs o on o.id = p.org_id
    left join lateral (
      select e.detail->'decision'->>'action' as agent_action,
             e.detail->'referenceDecision'->>'action' as policy_action,
             (nullif(e.detail->>'guardrailRule', '') is not null or coalesce((e.detail->>'guardrailBlocked')::boolean, false)) as refused
        from public.ledger_entries e
       where e.org_id = p.org_id and e.actor = 'agent' and e.detail ? 'decisionMode' and e.seq < p.seq
         and not (e.detail ? 'guardrailFixture')
         and ((p.detail ? 'invoiceId' and e.detail->>'invoiceId' = p.detail->>'invoiceId')
           or (p.detail ? 'milestoneId' and e.detail->>'milestoneId' = p.detail->>'milestoneId'))
       order by e.seq desc
       limit 1
    ) a on true
   where p.actor = 'human'
     and p.action in ('approval_paid', 'approval_rejected', 'approval_returned', 'milestone_approval_paid', 'milestone_closed',
                      'screening_match_dismissed', 'policy_proposal_accepted', 'policy_proposal_dismissed')
   order by p.seq`;

interface PersonRow {
  seq: string;
  ts: Date;
  action: string;
  side: "ours" | "customers";
  slug: string;
  agent_action: string | null;
  policy_action: string | null;
  refused: boolean;
  dismissed: number;
}

/** `--from <iso>` and `--to <iso>`: the window to measure; open on either side when left out. */
function windowArgs(argv: string[]): { from?: string; to?: string } {
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const raw = argv[at + 1];
    if (!raw || Number.isNaN(Date.parse(raw))) throw new Error(`${flag} needs a date, such as 2026-10-01T05:48:00Z`);
    return new Date(raw).toISOString();
  };
  return { from: value("--from"), to: value("--to") };
}

interface Row {
  seq: string;
  ts: Date;
  domain: string;
  summary: string;
  side: "ours" | "customers";
  slug: string;
  mode: string;
  model_action: string | null;
  policy_action: string | null;
  model_amount: string | null;
  policy_amount: string | null;
  agreed: boolean | null;
  guardrail_rule: string | null;
  guardrail_blocked: boolean;
  confidence: string | null;
  outcome: string | null;
}

async function main() {
  const client = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // A read-only transaction, which holds through a transaction-mode pooler as a session setting may not.
    await client.query("begin transaction read only");
    const { rows } = await client.query<Row>(DECISIONS);
    const people = (await client.query<PersonRow>(PEOPLE)).rows;
    await client.query("commit");
    const { from, to } = windowArgs(process.argv.slice(2));
    const decisions: RecordedDecision[] = rows.map((row) => ({
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      domain: row.domain,
      workspace: row.side === "ours" ? row.slug : "a customer's workspace",
      mode: row.mode,
      modelAction: row.model_action,
      policyAction: row.policy_action,
      agreed: agreementOf({
        domain: row.domain,
        mode: row.mode,
        modelAction: row.model_action,
        policyAction: row.policy_action,
        modelAmount: row.model_amount === null ? null : Number(row.model_amount),
        policyAmount: row.policy_amount === null ? null : Number(row.policy_amount),
        recorded: typeof row.agreed === "boolean" ? row.agreed : null,
      }),
      guardrailRule: row.guardrail_rule,
      guardrailBlocked: row.guardrail_blocked,
      confidence: row.confidence === null ? null : Number(row.confidence),
      summary: row.side === "ours" ? row.summary : "—",
      outcome: row.outcome,
    }));
    const measured = within(decisions, from, to);
    const customers = within(rows.map((row) => ({ ...row, ts: row.ts.toISOString() })), from, to).filter((row) => row.side === "customers").length;
    if (from || to) console.log(`Window: ${from ?? "the start"} to ${to ?? "now"}.\n`);
    console.log(summaryMarkdown(summarizeDecisions(measured)));
    console.log(`\n${customers} of these decisions were made in customers' workspaces, as /open counts them.`);
    const decidedByPeople: PersonDecision[] = people.map((row) => ({
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      workspace: row.side === "ours" ? row.slug : "a customer's workspace",
      action: row.action,
      agentAction: row.agent_action,
      policyAction: row.policy_action,
      refusedByCode: row.refused,
      dismissed: Number(row.dismissed),
    }));
    console.log(`\n${peopleMarkdown(summarizePeople(within(decidedByPeople, from, to)))}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
