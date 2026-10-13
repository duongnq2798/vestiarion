import type { CollectionInvoice, CollectionMember, CollectionsView } from "@/lib/collection-context/page";
import { buildCollections } from "@/lib/collection-context/page";
import { defaultPolicy, type CollectionPolicy, type CollectionTask, type CrmContext, type CustomerSaid } from "@/lib/collection-context/model";
import { hubspotDealUrl } from "@/lib/collection-context/read";
import type { PayLinkState } from "@/lib/platform/pay-links";

/**
 * Collections that follow the customer's context, with sample data, for the feature's pictures
 * (docs/superpowers/specs/2026-10-13-collections-context-design.md, `docs/superpowers/specs/collections-context-shots/`):
 * Northstar Studio's receivables on Tuesday, Oct 20, 2026, one of each kind of next step, built by the page's own
 * `buildCollections`. Made up: no workspace has these invoices.
 */

export const COLLECTIONS_NOW = Date.UTC(2026, 9, 20, 9, 0);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ANA = uuid(9301);
const BEN = uuid(9302);
const CY = uuid(9303);
const MEMBERS: CollectionMember[] = [
  { userId: ANA, email: "ana@northstar.example", role: "owner" },
  { userId: BEN, email: "ben@northstar.example", role: "admin" },
  { userId: CY, email: "cy@northstar.example", role: "approver" },
];

const customer = (n: number) => uuid(1300 + n);
let next = 0;
const invoice = (n: number, name: string, fields: Partial<CollectionInvoice> & Pick<CollectionInvoice, "amount" | "due_date" | "memo">): CollectionInvoice => {
  next += 1;
  return {
    id: uuid(2300 + next),
    counterparty_id: customer(n),
    counterparty_name: name,
    direction: "receivable",
    currency: "USDC",
    status: "pending",
    po_reference: null,
    settled_at: null,
    deal_id: null,
    ...fields,
  };
};

/** A VIP whose rules say ask first: the second reminder waits for the account owner's OK. */
export const ACME = invoice(1, "Acme Retail", { amount: 1800, due_date: "2026-10-15T00:00:00Z", memo: "INV-1042 · October retainer", po_reference: "PO-ACME-77" });
const BLUEBIRD = invoice(2, "Bluebird Cafe", { amount: 640, due_date: "2026-10-08T00:00:00Z", memo: "INV-1050 · Menu design" });
const GRANITE = invoice(3, "Granite Labs", { amount: 3000, due_date: "2026-10-17T00:00:00Z", memo: "INV-1058 · Website rebuild, deposit", deal_id: uuid(5301) });
const LUMEN = invoice(4, "Lumen Health", { amount: 1200, due_date: "2026-10-14T00:00:00Z", memo: "INV-1061 · Brand guide" });
const ORCHID = invoice(5, "Orchid Dental", { amount: 450, due_date: "2026-10-18T00:00:00Z", memo: "INV-1063 · Booking page" });
const PIONEER = invoice(6, "Pioneer Labs", { amount: 1050, due_date: "2026-10-16T00:00:00Z", memo: "INV-1066 · Pitch deck" });
const QUARRY = invoice(7, "Quarry & Stone", { amount: 2200, due_date: "2026-10-13T00:00:00Z", memo: "INV-1068 · Catalogue" });
const JUNO = invoice(8, "Juno Partners", { amount: 2000, due_date: "2026-10-19T00:00:00Z", memo: "INV-1070 · Annual report" });
const PAID = invoice(1, "Acme Retail", { amount: 1800, due_date: "2026-09-15T00:00:00Z", memo: "INV-1031 · September retainer", status: "received", settled_at: "2026-09-16T10:00:00Z" });

export const COLLECTION_INVOICES: CollectionInvoice[] = [ACME, BLUEBIRD, GRANITE, LUMEN, ORCHID, PIONEER, QUARRY, JUNO, PAID];

const link = (slug: string, sent: PayLinkState["sent"], over: Partial<PayLinkState> = {}): PayLinkState => ({
  url: `https://www.vestiarion.xyz/pay/${slug}`,
  legacy: false,
  remindersOnAt: "2026-10-01T08:00:00Z",
  deferredUntil: null,
  sent,
  ...over,
});

const LINKS = new Map<string, PayLinkState>([
  [ACME.id, link("acme-1042", [{ number: 1, tone: "friendly", sentAt: "2026-10-12T09:00:00Z" }])],
  [BLUEBIRD.id, link("bluebird-1050", [{ number: 1, tone: "friendly", sentAt: "2026-10-05T09:00:00Z" }])],
  [GRANITE.id, link("granite-1058", [{ number: 1, tone: "friendly", sentAt: "2026-10-14T09:00:00Z" }])],
  [LUMEN.id, link("lumen-1061", [{ number: 1, tone: "friendly", sentAt: "2026-10-11T09:00:00Z" }, { number: 2, tone: "friendly", sentAt: "2026-10-14T09:00:00Z" }])],
  [ORCHID.id, link("orchid-1063", [])],
  [PIONEER.id, link("pioneer-1066", [{ number: 1, tone: "friendly", sentAt: "2026-10-13T09:00:00Z" }])],
  [JUNO.id, link("juno-1070", [])],
]);

const said = (n: number, fields: Partial<CustomerSaid> & Pick<CustomerSaid, "kind">): CustomerSaid => ({
  id: uuid(7300 + n),
  status: "open",
  outcome: null,
  promisedOn: null,
  paidOn: null,
  createdAt: "2026-10-15T10:00:00Z",
  closedAt: null,
  ...fields,
});

const BROKEN_PROMISE = said(1, { kind: "promise", promisedOn: "2026-10-16", createdAt: "2026-10-09T07:55:00Z" });
const SAID = new Map<string, CustomerSaid[]>([
  [BLUEBIRD.id, [BROKEN_PROMISE]],
  [ORCHID.id, [said(2, { kind: "dispute", createdAt: "2026-10-18T14:20:00Z" })]],
  [PIONEER.id, [said(3, { kind: "paid", paidOn: "2026-10-19", createdAt: "2026-10-19T16:40:00Z" })]],
]);

/** Acme Retail's rules, version 2: ask Ana first, at most firm, a week apart. */
export const ACME_RULES: CollectionPolicy = {
  ...defaultPolicy(ACME.counterparty_id),
  id: uuid(6301),
  version: 2,
  approval: "ask_first",
  maxTone: "firm",
  minDaysBetween: 7,
  accountOwner: ANA,
  createdBy: ANA,
  createdAt: "2026-10-02T10:00:00Z",
};

const task = (n: number, fields: Partial<CollectionTask> & Pick<CollectionTask, "invoiceId" | "counterpartyId" | "kind" | "reason" | "subjectKey">): CollectionTask => ({
  id: uuid(6400 + n),
  assignee: null,
  policyVersion: 0,
  proposal: { headline: "", reasons: [], reminder: null },
  status: "open",
  outcome: null,
  holdUntil: null,
  approvedNumber: null,
  approvedTone: null,
  resolvedAt: null,
  resolvedBy: null,
  notifiedAt: "2026-10-20T06:00:00Z",
  createdAt: "2026-10-20T06:00:00Z",
  ...fields,
});

const TASKS: CollectionTask[] = [
  task(1, {
    invoiceId: ACME.id,
    counterpartyId: ACME.counterparty_id,
    kind: "ask_owner",
    reason: "policy_ask_first",
    subjectKey: "policy:2:reminder:2",
    assignee: ANA,
    policyVersion: 2,
    proposal: { headline: "Ask the account owner before reminding", reasons: [], reminder: { number: 2, tone: "firm", tones: ["friendly", "firm"], channel: "email", daysFromDue: 5, owed: 1800, received: 0 } },
  }),
  task(2, { invoiceId: BLUEBIRD.id, counterpartyId: BLUEBIRD.counterparty_id, kind: "finance_review", reason: "promise_passed", subjectKey: `promise:${BROKEN_PROMISE.id}` }),
  task(3, {
    invoiceId: GRANITE.id,
    counterpartyId: GRANITE.counterparty_id,
    kind: "ask_owner",
    reason: "hubspot_owner",
    subjectKey: "hubspot:30117482911",
    proposal: { headline: "Ask the deal's owner before reminding", reasons: [], reminder: { number: 2, tone: "firm", tones: ["friendly", "firm"], channel: "email", daysFromDue: 3, owed: 3000, received: 0 } },
  }),
];

const CRM = new Map<string, CrmContext>([
  [GRANITE.id, { provider: "hubspot", dealExternalId: "30117482911", dealName: "Website rebuild", ownerId: "77001", url: hubspotDealUrl("48291736", "30117482911") }],
]);

const BILLING = new Map<string, string | null>(COLLECTION_INVOICES.map((invoice) => [invoice.counterparty_id, invoice.counterparty_name === "Quarry & Stone" ? null : `ap@${invoice.counterparty_name.split(" ")[0].toLowerCase()}.example`]));

/** The receivables, their proposals and the panel, as the Receivables tab builds them. */
export function collectionsShot(href: (invoiceId: string) => string, focus: readonly string[] = []): CollectionsView {
  return buildCollections({
    orgName: "Northstar Studio",
    network: "arc-testnet",
    origin: "https://www.vestiarion.xyz",
    now: COLLECTIONS_NOW,
    invoices: COLLECTION_INVOICES,
    billingEmails: BILLING,
    // Juno Partners paid 1,200.00 of its 2,000.00 USDC.
    owed: (invoice) => (invoice.id === JUNO.id ? { owed: 800, received: 1200 } : { owed: invoice.status === "pending" ? invoice.amount : 0, received: 0 }),
    links: LINKS,
    said: SAID,
    policies: { available: true, latest: new Map([[ACME.counterparty_id, ACME_RULES]]) },
    tasks: TASKS,
    crm: CRM,
    members: MEMBERS,
    focus,
    sentThisWeek: 4,
    promises: [
      { promisedOn: "2026-09-25", outcome: "resolved", settledAt: "2026-09-24T10:00:00Z" },
      { promisedOn: "2026-10-02", outcome: "resolved", settledAt: "2026-10-02T15:00:00Z" },
      { promisedOn: "2026-10-09", outcome: "resolved", settledAt: "2026-10-08T09:00:00Z" },
      { promisedOn: "2026-10-16", outcome: null, settledAt: null },
    ],
    href,
  });
}

/** The receivables each picture opens. */
export const COLLECTION_SHOTS = { vip: ACME.id, hubspot: GRANITE.id, promise: BLUEBIRD.id, remind: LUMEN.id } as const;
