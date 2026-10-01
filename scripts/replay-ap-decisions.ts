/**
 * Asks the model again about payable decisions it already made, with today's
 * prompt and the facts each decision's ledger entry recorded (research note
 * "When the model and the policy disagree"). It measures a prompt change on
 * real cases without waiting for them to recur.
 *
 *   npm run research:replay -- 426 429 387 385 --runs 3
 *
 * Reads the database in a read-only transaction and writes nothing anywhere:
 * the model's answers are printed, not recorded. Needs the database variables
 * `npm run db:migrate` needs, and the model's key the agent uses.
 */
import { config } from "dotenv";
import { Client } from "pg";
import { z } from "zod";

config({ path: [".env.local", ".env"], quiet: true });

function connectionString(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const ref = process.env.SUPABASE_PROJECT_ID;
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!ref || !password) throw new Error("Set SUPABASE_PROJECT_ID and SUPABASE_DATABASE_PASSWORD (or SUPABASE_DB_URL) in .env.local");
  const region = process.env.SUPABASE_REGION ?? "us-east-1";
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

const answerSchema = z.object({ action: z.string(), reasoning: z.string(), confidence: z.number().nullish() });

function argvOptions(argv: string[]): { seqs: number[]; runs: number } {
  const at = argv.indexOf("--runs");
  const runs = at === -1 ? 1 : Number(argv[at + 1]);
  const seqs = argv.filter((arg, index) => /^\d+$/.test(arg) && index !== at + 1).map(Number);
  if (seqs.length === 0 || !Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error("Usage: npm run research:replay -- <ledger seq> [<seq> …] [--runs 1-10]");
  }
  return { seqs, runs };
}

async function main() {
  const { seqs, runs } = argvOptions(process.argv.slice(2));
  const { configFromEnv } = await import("../src/lib/config");
  const { runWithConfig } = await import("../src/lib/context");
  const { decide } = await import("../src/lib/agent/decide");
  const { SYSTEM_PROMPT, apDecisionPrompt } = await import("../src/lib/agent/orchestrator");
  const { factsFromEntry } = await import("../src/lib/research/replay");

  const client = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  const cases = [];
  try {
    await client.query("begin transaction read only");
    for (const seq of seqs) {
      const entry = (await client.query(`select seq, ts, summary, org_id, detail from public.ledger_entries where seq = $1 and domain = 'ap' and detail ? 'decisionMode'`, [seq])).rows[0];
      if (!entry) throw new Error(`#${seq} is not a payable decision`);
      const invoice = (await client.query(`select memo, due_date from public.invoices where id = $1 and org_id = $2`, [entry.detail.invoiceId, entry.org_id])).rows[0] ?? null;
      const counterparty = (await client.query(`select name from public.counterparties where id = $1 and org_id = $2`, [entry.detail.counterpartyId, entry.org_id])).rows[0] ?? null;
      const ids = ((entry.detail.observed?.duplicateCheck?.matches ?? []) as Array<{ otherInvoiceId: string }>).map((match) => match.otherInvoiceId);
      const others = new Map<string, { amount: number; due_date: string }>();
      if (ids.length > 0) {
        for (const row of (await client.query(`select id, amount, due_date from public.invoices where id = any($1::uuid[]) and org_id = $2`, [ids, entry.org_id])).rows) {
          others.set(row.id, { amount: Number(row.amount), due_date: new Date(row.due_date).toISOString() });
        }
      }
      cases.push({
        entry,
        facts: factsFromEntry(
          { seq: Number(entry.seq), ts: new Date(entry.ts).toISOString(), summary: entry.summary, detail: entry.detail },
          { invoice: invoice && { memo: invoice.memo, due_date: new Date(invoice.due_date).toISOString() }, counterparty, others }
        ),
      });
    }
    await client.query("commit");
  } finally {
    await client.end();
  }

  const settings = configFromEnv(process.env);
  console.log("| Entry | Recorded: model / policy | Replayed | First replay's reasoning |");
  console.log("|---|---|---|---|");
  for (const { entry, facts } of cases) {
    const answers: Array<{ action: string; confidence: number | null; reasoning: string; mode: string }> = [];
    for (let run = 0; run < runs; run += 1) {
      const result = await runWithConfig(settings, () =>
        decide({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: apDecisionPrompt(facts),
          schema: answerSchema,
          fallback: () => ({ action: "(no model answer)", reasoning: "", confidence: null }),
        })
      );
      answers.push({ action: result.value.action, confidence: result.value.confidence ?? null, reasoning: result.value.reasoning, mode: result.mode });
    }
    const recorded = `${entry.detail.decision?.action} / ${entry.detail.referenceDecision?.action ?? "—"}`;
    const replayed = answers.map((answer) => `${answer.action}${answer.confidence === null ? "" : ` (${answer.confidence})`}`).join(", ");
    const first = answers[0].reasoning.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 240);
    console.log(`| #${entry.seq} | ${recorded} | ${replayed} | ${first}${answers[0].reasoning.length > 240 ? "…" : ""} |`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
