import type { Portfolio, WorkspaceTriage } from "@/lib/accountant/read";
import { routeTo, sortTriage, type TriageItem, type TriageKind } from "@/lib/accountant/triage";
import type { OrgRole } from "@/lib/auth/roles";
import type { Member, OpenInvitation } from "@/lib/platform/members";
import { summarizeUsage, monthOf, usageLimits, type UsageLimit, type UsageRow } from "@/lib/usage/model";
import type { UsageMonthView } from "@/lib/usage/read";

/**
 * Sample data for the accountant console's pictures (docs/superpowers/specs/2026-10-13-accountant-console-design.md,
 * `docs/superpowers/specs/accountant-console-shots/`): an outside accountant invited to three small businesses' workspaces,
 * on Oct 13, 2026, with what is open in each; one workspace's usage this month and its limits; and the members page of a
 * fourth business inviting its accountant. Every figure goes through the console's own functions. No slug here names a
 * real workspace, so every link and form on the pictures reaches nothing.
 */

export const ACCOUNTANT_NOW = new Date("2026-10-13T09:00:00.000Z");
export const ACCOUNTANT_EMAIL = "lena@ledgerline.example";

type ItemInput = { kind: TriageKind; title: string; detail: string; amount?: [number, string]; since: string; path: string; id: string };

function workspace(slug: string, name: string, role: OrgRole, inputs: ItemInput[], extra: Partial<WorkspaceTriage> = {}): WorkspaceTriage {
  const items: TriageItem[] = inputs.map((input) => ({
    key: `${slug}:${input.kind}:${input.id}`,
    kind: input.kind,
    workspace: { slug, name },
    title: input.title,
    detail: input.detail,
    amount: input.amount ? { value: input.amount[0], currency: input.amount[1] } : null,
    since: input.since,
    href: `/o/${slug}${input.path}`,
    ...routeTo(role, input.kind, input.kind === "limit" ? "agent_budget" : undefined),
  }));
  return { slug, name, role, mode: "live", network: "arc-testnet", items: sortTriage(items), unread: [], ...extra };
}

const HARBOR = workspace("harbor-bakery", "Harbor Bakery", "accountant", [
  { kind: "past_decide_by", id: "b1", title: "Coastal Flour Mill", detail: "Held for a person. Its decide-by day was Oct 10, 2026, to keep the early-payment discount.", amount: [2480, "USDC"], since: "2026-10-10", path: "/approvals#payable-b1" },
  { kind: "to_book", id: "p1", title: "A payment of Oct 11, 2026", detail: "Waiting for review before it is booked in Xero.", amount: [640, "USDC"], since: "2026-10-12T15:20:00.000Z", path: "/invoices?review=book-xero" },
  { kind: "to_book", id: "p2", title: "A payment of Oct 12, 2026", detail: "Waiting for review before it is booked in Xero.", amount: [1175.5, "USDC"], since: "2026-10-13T06:05:00.000Z", path: "/invoices?review=book-xero" },
  { kind: "receivable_overdue", id: "r1", title: "Seaside Cafe Group", detail: "Was due Sep 2, 2026.", amount: [3200, "USDC"], since: "2026-09-02", path: "/invoices?tab=receivables&open=r1" },
]);

const LUMEN = workspace("lumen-studio", "Lumen Studio", "accountant", [
  { kind: "customer_says_paid", id: "q1", title: "Acme Retail", detail: "Says it paid on Oct 11, 2026, reference ACME-WIRE-5531. Nothing is marked paid until the money is found.", amount: [1800, "USDC"], since: "2026-10-12T08:40:00.000Z", path: "/invoices?tab=receivables#from-customers" },
  { kind: "disputed", id: "q2", title: "Granite Labs", detail: "Disputes an invoice on its statement link. Its reminders wait while the dispute is open.", since: "2026-10-09T11:00:00.000Z", path: "/invoices?tab=receivables#from-customers" },
  { kind: "decision", id: "b2", title: "Pixel Print Co", detail: "Flagged for review. Decide by Oct 17, 2026.", amount: [950, "EURC"], since: "2026-10-11T07:30:00.000Z", path: "/approvals#payable-b2" },
  { kind: "connector", id: "xero", title: "Xero", detail: "Xero needs you to reconnect. Xero no longer accepts this connection: it was disconnected in Xero, or not used for 60 days.", since: "2026-10-12T22:10:00.000Z", path: "/settings#xero" },
]);

const PINE = workspace("pine-dental", "Pine Dental", "accountant", [
  { kind: "limit", id: "agent_budget", title: "Agent spending limit", detail: "500.00 USDC of 500.00 USDC today. Past it, the agent pays nothing on its own: each payment waits in Approvals for a person, held for the limit.", since: "2026-10-13T00:00:00.000Z", path: "/settings#usage" },
]);

export const ACCOUNTANT_PORTFOLIO: Portfolio = {
  workspaces: [HARBOR, LUMEN, PINE],
  items: sortTriage([...HARBOR.items, ...LUMEN.items, ...PINE.items]),
};

const row = (fields: Partial<UsageRow> & Pick<UsageRow, "kind" | "action">, times = 1): UsageRow[] =>
  Array.from({ length: times }, () => ({ quantity: 1, input_tokens: null, output_tokens: null, cost: null, cost_currency: null, ok: true, ...fields }));

const USAGE_ROWS: UsageRow[] = [
  ...row({ kind: "model_call", action: "payable", input_tokens: 2140, output_tokens: 310, cost: "0.006380", cost_currency: "USD" }, 162),
  ...row({ kind: "model_call", action: "extraction", input_tokens: 1450, output_tokens: 220, cost: "0.005100", cost_currency: "USD" }, 31),
  ...row({ kind: "model_call", action: "treasury", input_tokens: 980, output_tokens: 140, cost: "0.003360", cost_currency: "USD" }, 20),
  ...row({ kind: "model_call", action: "payable", ok: false }, 1),
  ...row({ kind: "circle_transfer", action: "payment", cost: "0.003190", cost_currency: "USD" }, 34),
  ...row({ kind: "circle_transfer", action: "treasury" }, 4),
  ...row({ kind: "x402_purchase", action: "payee_history", cost: "0.01", cost_currency: "USDC" }, 4),
  ...row({ kind: "email", action: "digest" }, 28),
  ...row({ kind: "email", action: "payment_notice" }, 21),
  ...row({ kind: "email", action: "invitation" }, 3),
  ...row({ kind: "email", action: "customer_wrote" }, 5),
  ...row({ kind: "connector_sync", action: "xero" }, 94),
  ...row({ kind: "connector_sync", action: "xero", ok: false }, 2),
];

export const ACCOUNTANT_USAGE: UsageMonthView = { available: true, month: monthOf(ACCOUNTANT_NOW), summary: summarizeUsage(USAGE_ROWS) };

export const ACCOUNTANT_LIMITS: UsageLimit[] = usageLimits({
  mode: "live",
  cyclesToday: null,
  sandboxCap: 20,
  budget: { remaining: 0, binding: "day", dailyUsdc: 500, weeklyUsdc: 2500, spentToday: 500, spentThisWeek: 1310 },
  service: { spentToday: 0.04, dailyCapUsdc: 0.05, balanceUsdc: 0.46, maxPriceUsdc: 0.01 },
  invitationsToday: 3,
  invitationCap: 50,
  connectors: [],
});

export const ACCOUNTANT_MEMBERS: Member[] = [
  { userId: "shot-owner", email: "maya@northstar.example", role: "owner", joinedAt: "2026-09-24T09:00:00Z" },
  { userId: "shot-approver", email: "ben@northstar.example", role: "approver", joinedAt: "2026-09-29T14:30:00Z" },
  { userId: "shot-accountant", email: "lena@ledgerline.example", role: "accountant", joinedAt: "2026-10-08T08:15:00Z" },
];

export const ACCOUNTANT_INVITATIONS: OpenInvitation[] = [{ id: "shot-invite-1", email: "omar@ledgerline.example", role: "accountant", expiresAt: "2026-10-20T00:00:00Z" }];
