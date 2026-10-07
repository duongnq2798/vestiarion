import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import { billDigits } from "./bill-amount";
import { plural, utcDay, utcMinute } from "./copy";
import { db, unwrap } from "./dal";
import { readShadowMode } from "./shadow-mode";
import { workspaceNetwork } from "./workspace-network";

/**
 * The shadow mode digest (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S8), `npm run traction-digest`: for
 * one workspace, each decision of the agent's on a real bill since a day, the person's verdict on it, what it pays and
 * its Arc testnet transaction, and how often the person agreed. A decision counts when someone gave a verdict on it, or
 * while shadow mode is on, when it came after shadow mode started. Printed as ASCII with no blank line, so it goes into
 * `arc-canteen update-traction` as it is. Reads run inside an organization scope.
 */

export interface DigestDecision {
  seq: number;
  ts: string;
  action: string;
  payee: string;
  /** The first sentence of the agent's reasoning, or null when it gave none. */
  reasoning: string | null;
  /** What the agent pays: the invoice's amount and currency. */
  amount: number;
  currency: string;
  /** The bill as it was written, when it was in a currency of its own (shadow mode S6). */
  bill: { amount: number; currency: string } | null;
  verdict: { verdict: "agree" | "disagree"; reason: string | null } | null;
  /** The payment's transaction, on the payable's newest decision only. */
  txHash: string | null;
}

export interface DigestFacts {
  slug: string;
  network: string;
  explorer: string;
  shadow: { currency: string; startedAt: string } | null;
  since: string;
  decisions: DigestDecision[];
}

type DecisionRow = { seq: number | string; ts: string; action: string; detail: Record<string, unknown> | null };
type VerdictRow = { entry_seq: number | string; verdict: "agree" | "disagree"; reason: string | null };
type InvoiceRow = {
  id: string;
  amount: number | string;
  currency: string | null;
  tx_ref: string | null;
  original_currency: string | null;
  original_amount: number | string | null;
  counterparties: { name: string } | null;
};

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const REASONING_MAX = 200;

/** The first sentence of the decision's reasoning, kept short. */
function firstSentence(detail: Record<string, unknown> | null): string | null {
  const decision = detail?.decision;
  const reasoning = decision && typeof decision === "object" ? (decision as Record<string, unknown>).reasoning : null;
  if (typeof reasoning !== "string" || reasoning.trim() === "") return null;
  const sentence = (reasoning.trim().split(/(?<=[.!?])\s/)[0] ?? reasoning).trim();
  return sentence.length > REASONING_MAX ? `${sentence.slice(0, REASONING_MAX - 3).trimEnd()}...` : sentence;
}

export async function readDigestFacts(input: { slug: string; since: string }): Promise<DigestFacts> {
  const network = workspaceNetwork();
  const mode = await readShadowMode(db());
  const rows = (
    unwrap(
      await db()
        .from("ledger_entries")
        .select("seq, ts, action, detail")
        .eq("actor", "agent")
        .in("action", [...AGENT_DECISION_ACTIONS])
        .gte("ts", input.since)
        .order("seq", { ascending: true })
        .limit(1000)
    ) as DecisionRow[]
  ).filter((row) => typeof row.detail?.invoiceId === "string");

  const seqs = rows.map((row) => Number(row.seq));
  const verdicts = new Map<number, DigestDecision["verdict"]>();
  if (seqs.length > 0) {
    for (const row of unwrap(await db().from("decision_verdicts").select("entry_seq, verdict, reason").in("entry_seq", seqs)) as VerdictRow[]) {
      verdicts.set(Number(row.entry_seq), { verdict: row.verdict, reason: row.reason });
    }
  }
  // A shadow decision: one given a verdict, or one made since shadow mode started, while it is on.
  const kept = rows.filter((row) => verdicts.has(Number(row.seq)) || (mode !== null && Date.parse(row.ts) >= Date.parse(mode.startedAt)));

  const ids = [...new Set(kept.map((row) => row.detail?.invoiceId as string))];
  const invoices = new Map<string, InvoiceRow>();
  if (ids.length > 0) {
    const read = unwrap(
      await db().from("invoices").select("id, amount, currency, tx_ref, original_currency, original_amount, counterparties(name)").in("id", ids)
    ) as unknown as InvoiceRow[];
    for (const row of read) invoices.set(row.id, row);
  }
  // The payment went out on the payable's newest decision: its transaction goes there.
  const newest = new Map<string, number>();
  for (const row of kept) newest.set(row.detail?.invoiceId as string, Number(row.seq));

  const decisions: DigestDecision[] = [];
  for (const row of kept) {
    const invoiceId = row.detail?.invoiceId as string;
    const invoice = invoices.get(invoiceId);
    if (!invoice) continue;
    const seq = Number(row.seq);
    const tx = invoice.tx_ref && TX_HASH.test(invoice.tx_ref) && newest.get(invoiceId) === seq ? invoice.tx_ref : null;
    decisions.push({
      seq,
      ts: row.ts,
      action: row.action,
      payee: invoice.counterparties?.name ?? "a supplier",
      reasoning: firstSentence(row.detail),
      amount: Number(invoice.amount),
      currency: invoice.currency ?? "USDC",
      bill: invoice.original_currency && invoice.original_amount != null ? { amount: Number(invoice.original_amount), currency: invoice.original_currency } : null,
      verdict: verdicts.get(seq) ?? null,
      txHash: tx,
    });
  }
  return {
    slug: input.slug,
    network: network.label,
    explorer: network.explorer,
    shadow: mode ? { currency: mode.currency, startedAt: mode.startedAt } : null,
    since: input.since,
    decisions,
  };
}

/** Text in ASCII: letters keep their base form, typographic marks their plain ones, and anything else is dropped. */
export function asciiOnly(text: string): string {
  return text
    .replace(/[đĐ]/g, (letter) => (letter === "đ" ? "d" : "D"))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−·•]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E]/g, "");
}

const ACTION_WORDS: Record<string, string> = { ap_pay: "pay", ap_schedule: "schedule", ap_hold: "hold", ap_flag_fraud: "flag", ap_request_info: "ask about" };

const grouped = (value: number, digits: number) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A sentence's end: a full stop unless it has one. */
const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Every payee's name in the text in place of its alias. */
function aliased(text: string, aliases: Map<string, string>): string {
  let out = text;
  for (const [name, alias] of [...aliases].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), alias);
  }
  return out;
}

export function formatDigest(facts: DigestFacts, options: { hidePayees?: boolean } = {}): string {
  const aliases = new Map<string, string>();
  if (options.hidePayees) {
    for (const decision of facts.decisions) {
      if (!aliases.has(decision.payee)) aliases.set(decision.payee, `Supplier ${String.fromCharCode(65 + (aliases.size % 26))}`);
    }
  }
  const named = (text: string) => (options.hidePayees ? aliased(text, aliases) : text);

  const given = facts.decisions.filter((decision) => decision.verdict !== null);
  const agreed = given.filter((decision) => decision.verdict?.verdict === "agree").length;
  const waiting = facts.decisions.length - given.length;
  const count = `${facts.decisions.length} ${plural(facts.decisions.length, "decision", "decisions")} since ${utcDay(facts.since)}.`;
  const rate =
    given.length === 0
      ? " No verdicts yet."
      : ` Agreed with ${agreed} of ${given.length} ${plural(given.length, "verdict", "verdicts")} (${Math.round((agreed / given.length) * 100)}%)` +
        (waiting > 0 ? `; ${waiting} ${plural(waiting, "decision has", "decisions have")} no verdict yet.` : ".");

  const lines = [
    facts.shadow
      ? `Vestiarion shadow mode, workspace ${facts.slug} on ${facts.network}: on since ${utcDay(facts.shadow.startedAt)}, bills in ${facts.shadow.currency}.`
      : `Vestiarion shadow mode, workspace ${facts.slug} on ${facts.network}: off now.`,
    `${count}${rate}`,
    ...facts.decisions.map((decision) => {
      const paid = `${grouped(decision.amount, 2)} ${decision.currency}`;
      const money = decision.bill ? `${grouped(decision.bill.amount, billDigits(decision.bill.currency))} ${decision.bill.currency} (${paid})` : paid;
      const verdict = decision.verdict
        ? decision.verdict.verdict === "agree"
          ? "agreed"
          : decision.verdict.reason
            ? `disagreed: ${named(decision.verdict.reason)}`
            : "disagreed"
        : "none yet";
      return [
        `- ${utcMinute(decision.ts)}: ${ACTION_WORDS[decision.action] ?? decision.action} ${named(decision.payee)} ${money}.`,
        decision.reasoning ? ` Agent: ${ended(named(decision.reasoning))}` : "",
        ` Verdict: ${ended(verdict)}`,
        decision.txHash ? ` Tx: ${facts.explorer}/tx/${decision.txHash}` : "",
      ].join("");
    }),
  ];
  return lines
    .map((line) => asciiOnly(line).trim())
    .filter((line) => line !== "")
    .join("\n");
}
