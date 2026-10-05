import { utcDay } from "./copy";

/**
 * The agent's reasoning as a person reads it (docs/superpowers/specs/2026-10-02-plain-reasoning-design.md).
 *
 * What a decision stores is unchanged: the model's own words, with the notes code adds in brackets
 * (`[guardrail override: …]`, `[transfer failed: …]`), in the invoice or milestone and in its signed ledger
 * entry. This turns that into plain English for every screen and email that shows it:
 * - the notes become sentences ("Held for a person to approve: …");
 * - the model's words are shown as they are when they read as plain English, amounts to two decimals and
 *   dates as "Oct 2, 2026";
 * - when they read as a log (field names such as `goodsReceived`, `null`, `true`), the facts the decision
 *   recorded are explained instead, or, where none are at hand, only the sentences that read plainly are kept.
 *
 * Pure: no database, no React, so a server page, a client card and an email read it alike.
 */

/** Words that only a program writes: field names in either case style, paths, raw values, code. */
const TECHNICAL = [
  /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/, // camelCase: goodsReceived, riskLevel
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/, // snake_case: no_history_yet, flag_fraud
  /\b(?:null|undefined|true|false|NaN)\b/,
  /[{}`=]/,
  /\b(?:timing|invoice|treasury|counterparty|terms|payout|swap|usyc|observed|economics|milestone|contractor|verification|decision)\.[a-z]\w*/i,
];

export function isTechnical(text: string): boolean {
  return TECHNICAL.some((pattern) => pattern.test(text));
}

/** An amount as every card shows one: two decimals, and a fee below a cent kept to its first figures. */
export function plainAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return String(Number(value.toPrecision(2)));
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

const AMOUNT = /(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?=\s?(?:USDC|EURC|USYC|USD)\b)|\$(\d+)(\.\d+)?/g;
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b(?!T)/g;
/** A long decimal with no currency after it, of 1 or more: a balance the model quoted bare. Scores below 1 stay. */
const BARE_DECIMAL = /(?<![\d.$])\b([1-9]\d*\.\d{3,})\b(?!\s?(?:USDC|EURC|USYC|USD|%))/g;

/** Amounts in a currency to two decimals ("49.443396 USDC" → "49.44 USDC"), and ISO days as "Oct 2, 2026". */
export function plainFigures(text: string): string {
  return text
    .replace(AMOUNT, (match, dollar: string | undefined, whole: string | undefined, fraction: string | undefined, dollarWhole: string | undefined, dollarFraction: string | undefined) => {
      if (dollarWhole !== undefined) return `$${plainAmount(Number(`${dollarWhole}${dollarFraction ?? ""}`))}`;
      const value = Number(`${(whole ?? "").replace(/,/g, "")}${fraction ?? ""}`);
      return Number.isFinite(value) ? `${dollar ?? ""}${plainAmount(value)}` : match;
    })
    .replace(BARE_DECIMAL, (_match, value: string) => plainAmount(Number(value)))
    .replace(ISO_DAY, (match, year: string, month: string, day: string) => {
      const at = Date.UTC(Number(year), Number(month) - 1, Number(day));
      return Number.isNaN(at) ? match : utcDay(new Date(at).toISOString());
    });
}

/** The model's words, and the notes code added after them in brackets (each starts lowercase: `[transfer failed: …]`). */
export function splitReasoning(raw: string): { prose: string; notes: string[] } {
  const notes: string[] = [];
  const prose = raw.replace(/\s*\[([a-z][^[\]]*)\]/g, (_match, note: string) => {
    notes.push(note.trim());
    return "";
  });
  return { prose: prose.trim(), notes };
}

const sentence = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** A detail taken from an error or a provider, kept only when it reads plainly. */
const plainDetail = (detail: string): string | null => {
  const trimmed = detail.trim().replace(/\.$/, "");
  if (!trimmed || isTechnical(trimmed) || trimmed.length > 160) return null;
  return trimmed === "provider reported failure" ? "Circle reported a failure" : trimmed;
};

/** What a guardrail did, as the sentence starts: held for a person, or refused outright. */
function guardrailLead(consequence: string): string {
  if (/held for a person/.test(consequence)) return "Held for a person to approve";
  if (/release refused/.test(consequence)) return "Not released";
  if (/refused/.test(consequence)) return "Not paid";
  return sentence(consequence).replace(/\.$/, "");
}

/** One note code added to the reasoning, as a sentence; null for one that cannot be said plainly. */
export function noteSentence(note: string): string | null {
  const after = (prefix: string) => note.slice(prefix.length).trim();
  if (note.startsWith("guardrail override:")) {
    const body = after("guardrail override:");
    const dash = body.lastIndexOf(" — ");
    const reason = (dash >= 0 ? body.slice(0, dash) : body)
      .replace(/^\d[\d.,]* exceeds/, "the amount exceeds")
      .replace(/^(amount|counterparty|contractor) /, "the $1 ")
      .replace(/: /g, "; ");
    const [consequence, ...more] = dash >= 0 ? body.slice(dash + 3).split("; ") : [""];
    const lead = dash >= 0 ? guardrailLead(consequence) : "Not paid";
    const then = more.filter((part) => !isTechnical(part)).map(sentence).join(" ");
    return plainFigures([isTechnical(reason) ? `${lead}.` : `${lead}: ${reason}.`, then].filter(Boolean).join(" "));
  }
  if (note.startsWith("transfer failed:")) {
    const detail = plainDetail(after("transfer failed:"));
    return detail ? plainFigures(`The transfer failed: ${detail}.`) : "The transfer failed.";
  }
  if (note.startsWith("execution failed:")) return "The payment could not be sent.";
  if (note.startsWith("transfer submitted")) return "The transfer was sent and is waiting for Circle to confirm it.";
  if (note === "approved and paid by a person") return "A person approved and paid it.";
  if (note === "paid now by a person") return "A person chose Pay now.";
  if (note.startsWith("closed without paying by a person:")) return `A person closed it without paying: ${after("closed without paying by a person:").replace(/\.$/, "")}.`;
  if (note.startsWith("balance sync failed:")) return "The wallet balance could not be refreshed afterwards.";
  if (note.startsWith("approval interrupted:")) return "An approval was interrupted before it finished, so it is waiting again.";
  if (note === "no operating account configured") return "Not paid: this workspace has no operating account.";
  if (note.startsWith("not resubmitted:")) return plainFigures(sentence(`Not sent again: ${after("not resubmitted:")}`));
  if (note.startsWith("sent in a batch whose answer was lost")) return "Sent in a batch whose answer was lost; it is looked up on Circle and never sent twice.";
  if (note.startsWith("paying now:")) return plainFigures(sentence(`Paid now: ${after("paying now:").replace(/the date chosen/, "the date the agent chose")}`));
  if (note.startsWith("scheduled for the due date")) return plainFigures(sentence(note.replace(/the date chosen/, "the date the agent chose")));
  return isTechnical(note) ? null : plainFigures(sentence(note));
}

/** The sentences of a log-like text that read plainly, with any technical aside in brackets taken out. */
export function plainSentences(prose: string): string[] {
  return prose
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/)
    .map((part) => part.replace(/\s*\(([^()]*)\)/g, (match, inside: string) => (isTechnical(inside) ? "" : match)).trim())
    .filter((part) => part.length > 0 && !isTechnical(part))
    .map((part) => plainFigures(sentence(part)));
}

/**
 * The reasoning a person reads. `explanation` is the decision's recorded facts in sentences (`explainPayable`,
 * `explainMilestone`, `explainTreasury`), said instead of the model's words when those read as a log. Empty
 * when there is nothing to say: the caller has its own line for that.
 */
export function presentReasoning(raw: string | null | undefined, explanation: string[] = []): string {
  const { prose, notes } = splitReasoning(raw ?? "");
  const body = !prose ? [] : !isTechnical(prose) ? [plainFigures(sentence(prose))] : explanation.length > 0 ? explanation : plainSentences(prose);
  const said = notes.map(noteSentence).filter((line): line is string => Boolean(line));
  return [...body, ...said].join(" ");
}

// ---------------------------------------------------------------------------------------------------------
// How the model is asked to write it, so a new decision reads plainly before any of the above is needed.

/** The rule every decision prompt gives the model for its reasoning (plain reasoning R1). */
export const REASONING_RULE =
  "Your reasoning is read in the app by the business owner who approves payments, next to the same facts. Write 2 to 4 short sentences of plain English that cite the facts that decided it: amounts, dates, PO numbers, the counterparty's screening and limit, balances. Say each fact in words (\"the goods were received\", \"the counterparty's limit is 30 USDC\"), never as a field name or path from the input, and never write null, true or false. Give amounts to at most 2 decimals and dates as \"Oct 2, 2026\". Leave out facts that did not matter. Never write vague justifications like \"looks fine\" or \"seems reasonable\".";

/** The `reasoning` field of every response shape. */
export const REASONING_SHAPE = "2 to 4 plain-English sentences for the business owner: facts in words, no field names, null, true or false";

// ---------------------------------------------------------------------------------------------------------
// The facts a decision recorded, in sentences.

const usdc = (value: number) => `${plainAmount(value)} USDC`;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Who the counterparty is to screening, and whether the amount fits its limit. */
function screeningSentence(name: string, risk: string | null, amount: string, weighed: number | null, limit: number | null, verb: string): string {
  const screened =
    risk === "clear" ? `${name} passed screening` : risk === "medium" ? `${name} has a screening match to review` : risk === "high" ? `${name} is screened high risk` : `${name} has not been screened yet`;
  if (limit == null || weighed == null) return `${screened}.`;
  return weighed <= limit ? `${screened}, and ${amount} is within its ${usdc(limit)} limit.` : `${screened}, and ${amount} is above its ${usdc(limit)} limit, so code does not let the agent ${verb} it.`;
}

/** When it falls due, said from the day it was decided. */
function dueSentence(noun: string, dueDate: string | null, decidedAt: string | null): string | null {
  if (!dueDate) return null;
  const due = dueDate.slice(0, 10);
  if (!decidedAt) return `This ${noun} is due on ${utcDay(`${due}T00:00:00Z`)}.`;
  const day = decidedAt.slice(0, 10);
  if (due === day) return `This ${noun} was due on the day the agent decided it.`;
  return due < day ? `This ${noun} was already overdue when the agent decided it.` : `This ${noun} is due on ${utcDay(`${due}T00:00:00Z`)}.`;
}

export interface PayableFacts {
  name: string;
  amount: number;
  currency: string;
  dueDate: string | null;
  poReference: string | null;
  goodsReceived: boolean;
  /** The ledger entry the agent signed for its decision: its `decision`, `observed` and `usdcValue`. */
  entry: { ts: string; detail: Record<string, unknown> } | null;
}

const PAYABLE_ACTIONS: Record<string, (payOn: string | null) => string> = {
  pay: () => "The agent decided to pay it.",
  schedule: (payOn) => (payOn ? `The agent scheduled it for ${utcDay(`${payOn.slice(0, 10)}T00:00:00Z`)}.` : "The agent scheduled it for a later day."),
  hold: () => "The agent held it for a person to review.",
  request_info: () => "The agent asked for more information before paying it.",
  flag_fraud: () => "The agent flagged it as possible fraud.",
};

/** A payable's decision in sentences, from what its entry recorded: only what decides a payment. */
export function explainPayable(facts: PayableFacts): string[] {
  const detail = facts.entry?.detail ?? {};
  const observed = record(detail.observed) ?? {};
  const decision = record(detail.decision) ?? {};
  const amount = facts.currency === "USDC" ? usdc(facts.amount) : `${plainAmount(facts.amount)} ${facts.currency}`;
  const weighed = facts.currency === "USDC" ? facts.amount : num(detail.usdcValue);
  const lines: Array<string | null> = [
    dueSentence("invoice", facts.dueDate, facts.entry?.ts ?? null),
    screeningSentence(facts.name, text(observed.riskLevel), amount, weighed, num(observed.paymentLimit), "pay"),
    facts.poReference
      ? facts.goodsReceived
        ? `The purchase order ${facts.poReference} is on file and the goods were received.`
        : `The purchase order ${facts.poReference} is on file, but the goods are not marked received.`
      : // A counterparty paid without purchase orders needs none (three-way match design M4).
        observed.purchaseOrderRequired === false
        ? `No purchase order is needed for ${facts.name}, ${facts.goodsReceived ? "and the goods were received" : "but the goods are not marked received"}.`
        : "No purchase order is on file.",
  ];
  const balance = num(observed.operatingBalance);
  if (balance != null && facts.currency === "USDC") {
    lines.push(balance >= facts.amount ? "The operating wallet holds enough USDC to pay it." : `The operating wallet held ${usdc(balance)}, less than this invoice.`);
  }
  if (observed.addressUnconfirmed === true) lines.push("Its payment address changed and no one has confirmed it yet.");
  // The first payment to an address one person alone stood behind (new payee check N6).
  const newPayee = record(observed.newPayee);
  if (newPayee && newPayee.twoParties === false) lines.push(`This is the first payment to ${facts.name}'s address, and only one person stands behind it.`);
  const duplicates = num(record(observed.duplicateCheck)?.matchesTotal);
  if (duplicates != null) {
    lines.push(
      duplicates === 0
        ? text(observed.riskLevel) === "high"
          ? "No earlier invoice resembles it."
          : "No duplicate or high-risk signals were found."
        : `It resembles ${duplicates} earlier ${duplicates === 1 ? "invoice" : "invoices"} from ${facts.name}.`
    );
  }
  const action = text(decision.action);
  if (action && PAYABLE_ACTIONS[action]) lines.push(PAYABLE_ACTIONS[action](text(decision.payOn)));
  return lines.filter((line): line is string => Boolean(line));
}

export interface MilestoneFacts {
  name: string;
  amount: number;
  entry: { detail: Record<string, unknown> } | null;
}

/** A milestone's release decision in sentences, from what its entry recorded. */
export function explainMilestone(facts: MilestoneFacts): string[] {
  const detail = facts.entry?.detail ?? {};
  const observed = record(detail.observed) ?? {};
  const decision = record(detail.decision) ?? {};
  const verification = record(observed.verification);
  const method = text(verification?.method);
  const lines: Array<string | null> = [
    verification?.verified === false
      ? "The work is not verified yet."
      : method === "github"
        ? "The pull request for the work was merged."
        : method === "manual"
          ? "A person verified the work by hand."
          : "The work was verified.",
    screeningSentence(facts.name, text(observed.riskLevel), usdc(facts.amount), facts.amount, num(observed.paymentLimit), "release"),
  ];
  if (text(record(observed.performanceHistory)?.status) === "no_history_yet") lines.push(`${facts.name} has no payment history with this workspace yet.`);
  const action = text(decision.action);
  if (action === "release") lines.push("The agent decided to release it.");
  if (action === "hold") lines.push("The agent held it for a person to review.");
  return lines.filter((line): line is string => Boolean(line));
}

/** Dollars of yield or cost, where most are fractions of a cent: "$0.0041". */
const dollars = (value: number) => `$${plainAmount(value)}`;

/** A treasury decision in sentences, from the balances and the economics its entry recorded. */
export function explainTreasury(detail: Record<string, unknown>): string[] {
  const decision = record(detail.decision) ?? {};
  const economics = record(detail.economics) ?? {};
  const observed = record(detail.observed) ?? {};
  const action = text(decision.action);
  const amount = num(decision.amount);
  const idle = num(economics.idleAboveBuffer);
  const buffer = num(economics.requiredBuffer);
  const days = num(economics.expectedHoldDays);
  const earns = num(economics.projectedYieldUsd);
  const costs = num(economics.roundTripCostUsd);
  const lines: string[] = [];
  if (action === "hold") lines.push("The agent kept the cash in the operating wallet.");
  if (action === "sweep_to_usyc" && amount != null) lines.push(`The agent moved ${usdc(amount)} into the USYC reserve.`);
  if (action === "redeem_from_usyc" && amount != null) lines.push(`The agent moved ${usdc(amount)} back from the reserve to the operating wallet.`);
  if (idle != null && buffer != null) lines.push(`${usdc(Math.max(0, idle))} sat above the ${usdc(buffer)} kept for what falls due in the next 7 days.`);
  if (earns != null && costs != null && days != null && action !== "redeem_from_usyc") {
    const span = `${days} ${days === 1 ? "day" : "days"}`;
    lines.push(
      earns < costs
        ? `Parking it in the reserve for ${span} would earn about ${dollars(earns)}, less than the ${dollars(costs)} a move in and out costs.`
        : `Parking it in the reserve for ${span} should earn about ${dollars(earns)}, more than the ${dollars(costs)} a move in and out costs.`
    );
  }
  const due = num(observed.obligationsDue7d);
  if (action === "redeem_from_usyc" && due != null) lines.push(`${usdc(due)} falls due in the next 7 days.`);
  if (detail.usycSubscriptionsOpen === false && action !== "redeem_from_usyc") lines.push("USYC could not be bought until its next daily price update.");
  return lines;
}
