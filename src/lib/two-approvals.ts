/**
 * Two approvals above a limit (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1, T2): the workspace's
 * figure, in USDC, above which no payment to a payee leaves on one approval. Pure, so the console's forms, the agent's
 * guardrails and the approval actions all weigh a payment alike.
 */

/** The guardrail rule that holds a payment above the figure for two people (T3). */
export const TWO_APPROVALS_RULE = "workspace.two_approvals";

export interface WeighedPayment {
  amount: number;
  currency: "USDC" | "EURC";
  /** A EURC payment's USDC value as the agent last weighed it; null or absent when it has none. */
  usdcValue?: number | null;
}

/** What a payment is weighed at against the figure: its USDC amount, or a EURC payment's USDC value; null when not known (T2). */
export function weighedUsdc(payment: WeighedPayment): number | null {
  if (payment.currency === "USDC") return payment.amount;
  return payment.usdcValue ?? null;
}

/** Whether a payment needs two approvals: strictly above the figure, and always when its USDC value is not known (T2). */
export function needsTwoApprovals(payment: WeighedPayment, above: number | null): boolean {
  if (above === null) return false;
  const value = weighedUsdc(payment);
  return value === null || value > above;
}

/** The settings form (T1): a positive figure of USDC with at most 6 decimal places, or a blank to turn it off. */
export function parseTwoApprovalsForm(raw: string): { ok: true; above: number | null } | { ok: false; message: string } {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return { ok: true, above: null };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, message: "The figure must be a number of USDC." };
  if ((text.split(".")[1] ?? "").length > 6) return { ok: false, message: "The figure can have at most 6 decimal places." };
  const value = Number(text);
  if (!(value > 0)) return { ok: false, message: "The figure must be more than 0 USDC." };
  return { ok: true, above: value };
}

/** The rule in a sentence, as the card and the settings say it. */
export function twoApprovalsSentence(above: number): string {
  return `Payments above ${above} USDC need two approvals.`;
}
