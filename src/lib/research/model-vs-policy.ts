/**
 * The numbers behind the research note "When the model and the written
 * policy disagree" (content/docs/research/model-vs-policy.mdx). Every
 * decision the agent makes is the model's, and `decide()` also works out the
 * written policy's answer to the same facts; the signed ledger records both,
 * and whether code refused the model. This module turns those entries into
 * the note's figures; `scripts/model-vs-policy.ts` reads them from the
 * database, read-only, so anyone with access can reproduce the note.
 */

export interface RecordedDecision {
  /** The ledger entry's sequence number. */
  seq: number;
  ts: string;
  /** `ap`, `contractor` (a milestone) or `treasury`. */
  domain: string;
  workspace: string;
  /** `deepseek`, `anthropic`, `openai`, or `heuristic` when the rule-based fallback decided. */
  mode: string;
  modelAction: string | null;
  policyAction: string | null;
  /** Null when the policy's answer was not recorded, or the fallback decided. */
  agreed: boolean | null;
  /** The guardrail that refused the model's decision, or null. A milestone's refusal names no rule. */
  guardrailRule: string | null;
  /** Whether code refused the model's decision: a payable's entry also names the rule, a milestone's does not. */
  guardrailBlocked: boolean;
  confidence: number | null;
  summary: string;
  /** The invoice's status now, when the decision was about one. */
  outcome: string | null;
}

/** Actions that move money, now or on a later day. Every other action stops it. */
const MOVES_MONEY = new Set(["pay", "schedule", "release", "sweep_to_usyc", "redeem_from_usyc"]);

export interface DecisionSummary {
  from: string | null;
  to: string | null;
  workspaces: number;
  workspaceNames: string[];
  modelDecisions: number;
  fallbackDecisions: number;
  byMode: Record<string, number>;
  byDomain: Record<string, number>;
  /** Model decisions with the policy's answer recorded beside them. */
  measured: number;
  unmeasured: number;
  agreed: number;
  disagreed: number;
  agreementPercent: number | null;
  /** Agreement in each domain: treasury decisions that hold an empty balance agree easily, and can carry the total. */
  agreementByDomain: Array<{ domain: string; measured: number; agreed: number }>;
  /** The model's mean stated confidence where it chose the policy's action, and where it did not; null without any. */
  meanConfidence: { agreed: number | null; differed: number | null };
  /** The policy would have moved money; the model stopped it. */
  stricter: RecordedDecision[];
  /** The model would have moved money; the policy would not. */
  looser: RecordedDecision[];
  /** Both stopped it, by a different action: hold, request information or flag. */
  differentStop: RecordedDecision[];
  /** Both moved money, differently: paying now against scheduling, or two schedules on different days. */
  bothMove: RecordedDecision[];
  refusedByCode: RecordedDecision[];
  pairs: Array<{ model: string; policy: string; count: number }>;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function summarizeDecisions(rows: RecordedDecision[]): DecisionSummary {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const model = sorted.filter((row) => row.mode !== "heuristic");
  const measured = model.filter((row) => row.agreed !== null);
  const disagreements = measured.filter((row) => row.agreed === false);
  const moves = (action: string | null) => action !== null && MOVES_MONEY.has(action);

  const pairCounts = new Map<string, { model: string; policy: string; count: number }>();
  for (const row of disagreements) {
    const key = `${row.modelAction}\u0000${row.policyAction}`;
    const pair = pairCounts.get(key) ?? { model: row.modelAction ?? "?", policy: row.policyAction ?? "?", count: 0 };
    pair.count += 1;
    pairCounts.set(key, pair);
  }

  const agreed = measured.length - disagreements.length;
  const times = sorted.map((row) => row.ts).sort();
  return {
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    workspaces: new Set(sorted.map((row) => row.workspace)).size,
    workspaceNames: [...new Set(sorted.map((row) => row.workspace))],
    modelDecisions: model.length,
    fallbackDecisions: sorted.length - model.length,
    byMode: tally(sorted.map((row) => row.mode)),
    byDomain: tally(model.map((row) => row.domain)),
    measured: measured.length,
    unmeasured: model.length - measured.length,
    agreed,
    disagreed: disagreements.length,
    agreementPercent: measured.length === 0 ? null : Math.round((agreed / measured.length) * 1000) / 10,
    agreementByDomain: [...new Set(measured.map((row) => row.domain))].sort().map((domain) => {
      const inDomain = measured.filter((row) => row.domain === domain);
      return { domain, measured: inDomain.length, agreed: inDomain.filter((row) => row.agreed === true).length };
    }),
    meanConfidence: {
      agreed: mean(measured.filter((row) => row.agreed === true && row.confidence !== null).map((row) => row.confidence as number)),
      differed: mean(disagreements.filter((row) => row.confidence !== null).map((row) => row.confidence as number)),
    },
    stricter: disagreements.filter((row) => moves(row.policyAction) && !moves(row.modelAction)),
    looser: disagreements.filter((row) => moves(row.modelAction) && !moves(row.policyAction)),
    differentStop: disagreements.filter((row) => !moves(row.modelAction) && !moves(row.policyAction)),
    bothMove: disagreements.filter((row) => moves(row.modelAction) && moves(row.policyAction)),
    refusedByCode: model.filter((row) => row.guardrailBlocked || row.guardrailRule !== null),
    pairs: [...pairCounts.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model) || a.policy.localeCompare(b.policy)),
  };
}

const cell = (value: string | number | null) => (value === null ? "—" : String(value).replace(/\|/g, "\\|"));

/** The note's tables, as the script prints them. */
export function summaryMarkdown(summary: DecisionSummary): string {
  const percent = summary.agreementPercent === null ? "" : ` (${summary.agreementPercent}%)`;
  const lines = [
    `Decisions from ${summary.from ?? "—"} to ${summary.to ?? "—"}, in ${summary.workspaces} workspaces.`,
    "",
    "| | Count |",
    "|---|---|",
    `| Decisions by the model | ${summary.modelDecisions} |`,
    `| Decided by the rule-based fallback | ${summary.fallbackDecisions} |`,
    `| With the policy's answer recorded | ${summary.measured} |`,
    `| Same action as the policy | ${summary.agreed}${percent} |`,
    `| A different action | ${summary.disagreed} |`,
    `| Refused by code | ${summary.refusedByCode.length} |`,
    "",
    `By provider: ${Object.entries(summary.byMode).map(([mode, count]) => `${mode} ${count}`).join(", ")}.`,
    `Workspaces: ${summary.workspaceNames.join(", ")}.`,
    `By domain: ${Object.entries(summary.byDomain).map(([domain, count]) => `${domain} ${count}`).join(", ")}.`,
    "",
    "| Domain | Measured | Same action as the policy |",
    "|---|---|---|",
    ...summary.agreementByDomain.map(
      ({ domain, measured, agreed }) => `| ${domain} | ${measured} | ${agreed} (${measured === 0 ? 0 : Math.round((agreed / measured) * 1000) / 10}%) |`
    ),
    "",
    `The model's mean confidence: ${summary.meanConfidence.agreed ?? "—"} where it chose the policy's action, ${summary.meanConfidence.differed ?? "—"} where it did not.`,
    `Of the differences: ${summary.stricter.length} where the policy would have moved money and the model stopped it; ${summary.looser.length} where the model would have moved money and the policy would not; ${summary.differentStop.length} where both stopped it by a different action; ${summary.bothMove.length} where both moved money, differently.`,
    "",
    "| Entry | Workspace | Decision | Model | Policy | Confidence | Refused by | Invoice now |",
    "|---|---|---|---|---|---|---|---|",
    ...[...summary.stricter, ...summary.differentStop, ...summary.looser, ...summary.bothMove]
      .sort((a, b) => a.seq - b.seq)
      .map((row) => `| #${row.seq} | ${cell(row.workspace)} | ${cell(row.summary)} | ${cell(row.modelAction)} | ${cell(row.policyAction)} | ${cell(row.confidence)} | ${cell(row.guardrailRule)} | ${cell(row.outcome)} |`),
  ];
  return lines.join("\n");
}
