/**
 * Prints the numbers behind the research note "When the model and the
 * written policy disagree" (content/docs/research/model-vs-policy.mdx), read
 * from the database the app runs on.
 *
 *   npm run research:model-vs-policy
 *
 * Read-only: the session refuses writes. Needs SUPABASE_PROJECT_ID and
 * SUPABASE_DATABASE_PASSWORD (or SUPABASE_DB_URL), as `npm run db:migrate`
 * does. A customer's workspace is never named and its entries' summaries are
 * never printed: it is counted, as /open counts it.
 */
import { config } from "dotenv";
import { Client } from "pg";
import { summarizeDecisions, summaryMarkdown, type RecordedDecision } from "../src/lib/research/model-vs-policy";

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
         e.detail->'decision'->>'action' as model_action,
         e.detail->'referenceDecision'->>'action' as policy_action,
         e.detail->'agreedWithReference' as agreed,
         e.detail->>'guardrailRule' as guardrail_rule,
         e.detail->'decision'->>'confidence' as confidence,
         i.status as outcome
    from public.ledger_entries e
    join public.orgs o on o.id = e.org_id
    left join public.invoices i on i.id::text = e.detail->>'invoiceId'
   where e.actor = 'agent' and e.detail ? 'decisionMode'
   order by e.seq`;

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
  agreed: boolean | null;
  guardrail_rule: string | null;
  confidence: string | null;
  outcome: string | null;
}

async function main() {
  const client = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("set session characteristics as transaction read only");
    const { rows } = await client.query<Row>(DECISIONS);
    const decisions: RecordedDecision[] = rows.map((row) => ({
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      domain: row.domain,
      workspace: row.side === "ours" ? row.slug : "a customer's workspace",
      mode: row.mode,
      modelAction: row.model_action,
      policyAction: row.policy_action,
      agreed: typeof row.agreed === "boolean" ? row.agreed : null,
      guardrailRule: row.guardrail_rule,
      confidence: row.confidence === null ? null : Number(row.confidence),
      summary: row.side === "ours" ? row.summary : "—",
      outcome: row.outcome,
    }));
    const customers = rows.filter((row) => row.side === "customers").length;
    console.log(summaryMarkdown(summarizeDecisions(decisions)));
    console.log(`\n${customers} of these decisions were made in customers' workspaces, as /open counts them.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
