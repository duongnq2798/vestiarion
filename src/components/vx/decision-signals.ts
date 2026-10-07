import type { Decision } from "./types";

/** One fact the agent checked before deciding a payable, in a few words, and whether it stood in the payment's way. */
export interface DecisionSignal {
  label: string;
  state: "ok" | "missing" | "neutral";
}

const RISK: Readonly<Record<string, DecisionSignal>> = {
  clear: { label: "Screened clear", state: "ok" },
  medium: { label: "Medium risk", state: "neutral" },
  high: { label: "High risk", state: "missing" },
  unscreened: { label: "Not screened", state: "missing" },
};

/**
 * The checks a payable's card shows as evidence (the three-way match, the counterparty's screening, its limit), read
 * as a row's short line, so what the agent weighed shows without opening the row. Nothing here is new: each comes
 * from the card's own evidence, and a fact the card does not show is left out. None for a receivable.
 */
export function payableSignals(decision: Decision): DecisionSignal[] {
  if (decision.domain !== "ap") return [];
  const evidence = new Map(decision.evidence.map((item) => [item.label, item]));
  const signals: DecisionSignal[] = [];

  const po = evidence.get("PO");
  if (po) {
    if (po.value === "not needed") signals.push({ label: "No PO needed", state: "neutral" });
    else signals.push(po.state === "ok" ? { label: "PO on file", state: "ok" } : { label: "No PO", state: "missing" });
  }
  const goods = evidence.get("Goods received");
  if (goods) signals.push(goods.state === "ok" ? { label: "Goods received", state: "ok" } : { label: "Not received", state: "missing" });
  const risk = evidence.get("Risk");
  if (risk) signals.push(RISK[risk.value] ?? { label: `${risk.value} risk`, state: "neutral" });
  const limit = evidence.get("Limit");
  if (limit && limit.value !== "none") signals.push(limit.state === "missing" ? { label: "Over its limit", state: "missing" } : { label: "Within its limit", state: "ok" });

  return signals;
}
