import { utcMinute } from "./copy";

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

/**
 * A payment above the figure, as the pages that decide it show it (T8), and as the server weighs an approval of it (T5).
 */
export interface TwoApprovalsFacts {
  above: number;
  /** The approvals given that still count, the earlier first. */
  approvals: Array<{ by: string; at: string }>;
  /** The members left out: whoever entered it, and whoever gave a first payment's address. */
  excluded: string[];
  /** How many of the two approvals those left out may give (`excludedSlots`). */
  excludedSlots: number;
  /** How many people can approve payments in the workspace: with fewer than two, nothing above the figure can be paid. */
  approvers: number;
}

/**
 * How many of a payment's two approvals the people left out may give (T5), from how many others can approve: as many of
 * the two as can come from people independent of the payment must. None while two others can approve, one while one
 * can, both when no one else can.
 */
export function excludedSlots(independentApprovers: number): number {
  return 2 - Math.min(2, Math.max(0, independentApprovers));
}

/** Whether this person's approval may be given now (T5): the rule the server keeps, and the card shows. */
export function mayApproveNow(facts: Pick<TwoApprovalsFacts, "excluded" | "excludedSlots" | "approvals">, actorId: string): boolean {
  if (!facts.excluded.includes(actorId)) return true;
  const byExcluded = facts.approvals.filter((approval) => approval.by !== actorId && facts.excluded.includes(approval.by)).length;
  return byExcluded + 1 <= facts.excludedSlots;
}

/** What an approval says when it is the first of two and sends nothing (T8). */
export const APPROVAL_RECORDED = "Approved. One more approval, by another person, pays it.";

/**
 * What a card says of a payment above the figure (T8): the rule, and who approved it so far, by email; the viewer is
 * "You". Two approvals standing at once (two people approved together) say that the next one pays it, under the name
 * the button has where it is shown (`payLabel`).
 */
export function twoApprovalsLine(
  facts: Pick<TwoApprovalsFacts, "above" | "approvals">,
  viewerId: string,
  emails: Record<string, string> = {},
  payLabel = "Approve and pay"
): string {
  const head = `Payments above ${facts.above} USDC need two approvals.`;
  const [first, second] = facts.approvals;
  if (!first) return `${head} No one has approved it yet.`;
  const name = (by: string, capital: boolean) => (by === viewerId ? (capital ? "You" : "you") : (emails[by] ?? (capital ? "Another member" : "another member")));
  if (second) return `${head} ${name(first.by, true)} and ${name(second.by, false)} approved it, so the next ${payLabel} pays it.`;
  return `${head} ${name(first.by, true)} approved it on ${utcMinute(first.at)}. One more approval, by another person, pays it.`;
}

/** What a card says to the workspace's only approver of a payment above the figure: one person cannot give two approvals. */
export function onlyApproverOfTwo(above: number): string {
  return `You are the only person in this workspace who can approve payments, and payments above ${above} USDC need two approvals, so it cannot be paid until the figure is raised in Settings or another person who can approve joins.`;
}

/** What the confirmation of a first approval says it does (T8). */
export function approveFirstDescription(above: number): string {
  return `Payments above ${above} USDC need two approvals. This records your approval and sends nothing; another person's approval pays it.`;
}

/** The paying confirmation's added sentence when it is the second of two approvals. */
export const SECOND_APPROVAL_PAYS = "Yours is the second of two approvals, so it pays.";

/** Why an approval above the figure is refused where fewer than two people can approve payments: it could never pay (T5). */
export function needsSecondApprover(above: number): string {
  return `Payments above ${above} USDC need two approvals, and only one person in this workspace can approve payments. Raise the figure in Settings, or add an approver on Members.`;
}

/** The rule in a sentence, as the card and the settings say it. */
export function twoApprovalsSentence(above: number): string {
  return `Payments above ${above} USDC need two approvals.`;
}
