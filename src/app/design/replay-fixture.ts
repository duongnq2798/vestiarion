import { replayDecisions, withCandidate, type ReplayEntry, type RuleFigures } from "@/lib/policy-replay";
import { replayView, trialSetting, windowSpan, type CounterpartyNames, type RuleReplayView } from "@/lib/policy-replay-read";

/**
 * A replay as the sample data's first week would give it (docs/superpowers/specs/2026-10-10-policy-replay-design.md),
 * for /design and the guide's screenshot: Harbor Office Supply's 500 USDC limit, tried at 1,500 USDC. Built with the
 * replay's own pure functions, so what the page shows is what the server would answer for these decisions.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");

const NORTHWIND = "cp-northwind";
const HARBOR = "cp-harbor";
const KESTREL = "cp-kestrel";
const PINECREST = "cp-pinecrest";

const NAMES: CounterpartyNames = new Map([
  [NORTHWIND, { name: "Northwind Hosting", role: "vendor" }],
  [HARBOR, { name: "Harbor Office Supply", role: "vendor" }],
  [KESTREL, { name: "Kestrel Print Co", role: "vendor" }],
  [PINECREST, { name: "Pinecrest Engineering — Backend Contractor", role: "contractor" }],
]);

const FIGURES: RuleFigures = {
  counterpartyLimits: { [NORTHWIND]: 2000, [HARBOR]: 500, [KESTREL]: 1500, [PINECREST]: 5000 },
  twoApprovalsAbove: null,
  spendingLimit: { dailyUsdc: null, weeklyUsdc: null },
};

function decision(
  seq: number,
  ts: string,
  options: { action: string; counterpartyId: string; sourceId: string; amount: number; limit: number; rule?: string | null; paid?: boolean }
): ReplayEntry {
  const rule = options.rule ?? null;
  const bill = options.action.startsWith("ap_");
  return {
    seq,
    ts,
    action: options.action,
    detail: {
      ...(bill ? { invoiceId: options.sourceId, currency: "USDC" } : { milestoneId: options.sourceId }),
      ...(options.action === "ap_pay" ? { amountPaid: options.paid ? options.amount : null } : {}),
      counterpartyId: options.counterpartyId,
      decision: { action: options.action.replace(/^(ap|milestone)_/, "") },
      guardrailBlocked: rule !== null,
      guardrailRule: rule,
      observed: { amount: options.amount, paymentLimit: options.limit, riskLevel: "clear" },
      execution: { chainMode: "simulate", resultingStatus: options.paid ? "paid" : rule ? "held" : "scheduled" },
    },
  };
}

const ENTRIES: ReplayEntry[] = [
  decision(41, "2026-10-03T09:00:12.000Z", { action: "ap_pay", counterpartyId: NORTHWIND, sourceId: "inv-hosting", amount: 240, limit: 2000, paid: true }),
  decision(42, "2026-10-03T09:00:14.000Z", { action: "ap_request_info", counterpartyId: NORTHWIND, sourceId: "inv-bandwidth", amount: 95, limit: 2000 }),
  decision(43, "2026-10-03T09:00:16.000Z", { action: "ap_schedule", counterpartyId: NORTHWIND, sourceId: "inv-support", amount: 400, limit: 2000 }),
  decision(44, "2026-10-03T09:00:18.000Z", { action: "ap_pay", counterpartyId: HARBOR, sourceId: "inv-desks", amount: 1200, limit: 500, rule: "counterparty.payment_limit" }),
  decision(45, "2026-10-03T09:00:20.000Z", { action: "ap_pay", counterpartyId: KESTREL, sourceId: "inv-brochure", amount: 180, limit: 1500, rule: "invoice.duplicate_of_settled" }),
  decision(46, "2026-10-03T09:00:22.000Z", { action: "milestone_release", counterpartyId: PINECREST, sourceId: "ms-api", amount: 1200, limit: 5000, paid: true }),
  decision(58, "2026-10-07T09:00:10.000Z", { action: "ap_pay", counterpartyId: HARBOR, sourceId: "inv-paper", amount: 320, limit: 500, paid: true }),
];

const MEMOS = new Map<string, string | null>([
  ["inv-hosting", "Hosting — September"],
  ["inv-bandwidth", "Bandwidth overage"],
  ["inv-support", "Annual support plan"],
  ["inv-desks", "Standing desks"],
  ["inv-brochure", "Brochure print run"],
  ["inv-paper", "Printer paper"],
]);

/** Harbor Office Supply's limit tried at `limit` USDC on the sample's decisions, over the last 30 days. */
export function designRuleReplay(limit = "1500"): RuleReplayView {
  const trial = { rule: "counterparty_limit" as const, counterpartyId: HARBOR, values: { paymentLimit: limit }, days: 30 as const };
  const setting = trialSetting(trial, FIGURES, NAMES);
  const window = windowSpan(trial.days, NOW);
  const result = replayDecisions(ENTRIES, { windowStart: window.from, current: FIGURES, candidate: withCandidate(FIGURES, setting.candidate) });
  return replayView({
    rule: trial.rule,
    setting,
    result,
    window,
    actions: new Map(ENTRIES.map((entry) => [entry.seq, entry.action])),
    names: NAMES,
    memos: MEMOS,
    titles: new Map([["ms-api", "API rate-limiting module shipped"]]),
  });
}
