import { buildStatement, type CustomerRequest, type StatementView } from "@/lib/customer-portal/model";
import { homeChain } from "@/lib/payee-chains";
import type { PayLinkPreview } from "@/lib/platform/pay-links";
import { customerNote, fromCustomerItems, statementLinkRows, type FromCustomerView, type StatementLinkView } from "@/lib/customer-portal/view";
import { BILLS_COUNTERPARTIES, BILLS_INVOICES, BILLS_NOW } from "./bills-fixture";

/**
 * Customer statements with sample data, for the customer portal's pictures
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md, `docs/superpowers/specs/customer-portal-shots/`): the
 * statement Acme Retail reads from Northstar Studio on Tuesday, Oct 13, 2026, and what Bills & receivables' customers
 * said on Monday, Oct 12, over the bills pictures' own receivables. Made up: no workspace has these invoices.
 */

export const PORTAL_NOW = Date.UTC(2026, 9, 13, 9, 0);
export const PORTAL_TOKEN = `vxc_${"S".repeat(43)}`;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const request = (n: number, fields: Partial<CustomerRequest> & Pick<CustomerRequest, "kind" | "invoiceId">): CustomerRequest => ({
  id: uuid(7000 + n),
  counterpartyId: uuid(1021),
  linkId: uuid(6001),
  paidOn: null,
  reference: null,
  amount: null,
  promisedOn: null,
  status: "open",
  outcome: null,
  createdAt: "2026-10-12T10:00:00Z",
  closedAt: null,
  messages: [],
  ...fields,
});

const RETAINER = uuid(8001);
const PHOTOS = uuid(8002);
const HOSTING = uuid(8003);

const DISPUTE = request(1, {
  kind: "dispute",
  invoiceId: HOSTING,
  createdAt: "2026-10-11T14:20:00Z",
  messages: [
    { id: uuid(7101), author: "customer", body: "We moved to the smaller plan in September, so October should be 180.00 EURC, not 240.00.", createdAt: "2026-10-11T14:20:00Z", by: null },
    { id: uuid(7102), author: "business", body: "Thanks, checking the plan change now. We'll send a corrected invoice if it went through.", createdAt: "2026-10-12T08:05:00Z", by: null },
  ],
});

const CLAIM = request(2, { kind: "paid", invoiceId: RETAINER, paidOn: "2026-10-12", reference: "ACME-WIRE-5531", amount: 800, createdAt: "2026-10-12T16:40:00Z" });

/**
 * The statement Acme Retail reads; `claimed` adds what it just said about the retainer. `short`, for the guide's
 * picture, keeps the retainer and one paid invoice.
 */
export function statementShot(options: { claimed?: boolean; short?: boolean } = {}): StatementView {
  const view = buildStatement({
    orgName: "Northstar Studio",
    customerName: "Acme Retail",
    expiresAt: "2026-11-11T09:00:00Z",
    now: PORTAL_NOW,
    invoices: [
      { id: RETAINER, amount: 1800, currency: "USDC", dueDate: "2026-10-03T12:00:00Z", memo: "INV-1042 · October retainer", poReference: "PO-ACME-77", status: "pending", settledAt: null },
      { id: PHOTOS, amount: 650, currency: "USDC", dueDate: "2026-10-20T12:00:00Z", memo: "INV-1049 · Product photos", poReference: null, status: "pending", settledAt: null },
      { id: HOSTING, amount: 240, currency: "EURC", dueDate: "2026-10-28T12:00:00Z", memo: "INV-1051 · Hosting, October", poReference: null, status: "pending", settledAt: null },
      { id: uuid(8004), amount: 1800, currency: "USDC", dueDate: "2026-09-03T12:00:00Z", memo: "INV-1031 · September retainer", poReference: null, status: "received", settledAt: "2026-09-04T10:00:00Z" },
      { id: uuid(8005), amount: 1800, currency: "USDC", dueDate: "2026-08-03T12:00:00Z", memo: "INV-1024 · August retainer", poReference: null, status: "received", settledAt: "2026-08-05T10:00:00Z" },
    ],
    // 1,000.00 USDC of the retainer arrived and was applied: 800.00 is still owed.
    owed: new Map([[RETAINER, { outstanding: 800, received: 1000 }]]),
    payLinks: new Map([[RETAINER, "https://www.vestiarion.xyz/pay/vxr_acme-1042"]]),
    requests: options.claimed ? [DISPUTE, CLAIM] : [DISPUTE],
  });
  if (!options.short) return view;
  return { ...view, totals: view.totals.filter((total) => total.currency === "USDC").map((total) => ({ ...total, owed: 800, open: 1 })), open: view.open.slice(0, 1), paid: view.paid.slice(0, 1) };
}

/** The invoices each form opens on in the pictures. */
export const PORTAL_FORMS = { paid: RETAINER, promise: PHOTOS, dispute: PHOTOS } as const;

const receivable = (memo: string) => BILLS_INVOICES.find((invoice) => invoice.memo === memo) as (typeof BILLS_INVOICES)[number];
const ACME = receivable("INV-1042 · October retainer");
const BLUEBIRD = receivable("INV-1050 · Menu design");
const GRANITE = receivable("INV-1058 · Website rebuild, deposit");
const LUMEN = receivable("INV-1061 · Brand guide");
const MEMBER = uuid(9001);

const WORKSPACE_REQUESTS: CustomerRequest[] = [
  request(11, { kind: "paid", invoiceId: ACME.id, counterpartyId: ACME.counterparty_id, paidOn: "2026-10-11", reference: "ACME-WIRE-5531", amount: 1800, createdAt: "2026-10-11T16:40:00Z" }),
  request(12, {
    kind: "promise",
    invoiceId: BLUEBIRD.id,
    counterpartyId: BLUEBIRD.counterparty_id,
    promisedOn: "2026-10-16",
    createdAt: "2026-10-12T07:55:00Z",
    messages: [{ id: uuid(7201), author: "customer", body: "Our card payments settle on Thursday; we pay it then.", createdAt: "2026-10-12T07:55:00Z", by: null }],
  }),
  request(13, {
    kind: "dispute",
    invoiceId: GRANITE.id,
    counterpartyId: GRANITE.counterparty_id,
    createdAt: "2026-10-10T13:10:00Z",
    messages: [
      { id: uuid(7301), author: "customer", body: "The deposit in the signed quote is 2,500.00, not 3,000.00. Can you check?", createdAt: "2026-10-10T13:10:00Z", by: null },
      { id: uuid(7302), author: "business", body: "Checking the quote now.", createdAt: "2026-10-11T09:00:00Z", by: MEMBER },
    ],
  }),
  request(14, { kind: "pay_link", invoiceId: LUMEN.id, counterpartyId: LUMEN.counterparty_id, createdAt: "2026-10-12T08:30:00Z" }),
];

/** What customers said, as Bills & receivables lists it, each opening its receivable at `invoiceHref`. */
export function fromCustomersShot(invoiceHref: (invoiceId: string) => string, options: { kinds?: CustomerRequest["kind"][] } = {}): FromCustomerView[] {
  const receivables = [ACME, BLUEBIRD, GRANITE, LUMEN];
  return fromCustomerItems({
    requests: options.kinds ? WORKSPACE_REQUESTS.filter((request) => options.kinds?.includes(request.kind)) : WORKSPACE_REQUESTS,
    invoices: new Map(receivables.map((invoice) => [invoice.id, { id: invoice.id, counterpartyName: invoice.counterparty_name, amount: Number(invoice.amount), currency: invoice.currency ?? "USDC", status: invoice.status, dueDate: invoice.due_date, memo: invoice.memo }])),
    owedOf: (invoiceId) => Number(receivables.find((invoice) => invoice.id === invoiceId)?.amount ?? 0),
    payLinked: new Set([ACME.id]),
    sandbox: false,
    today: new Date(BILLS_NOW).toISOString().slice(0, 10),
    members: new Map([[MEMBER, "ana@northstar.example"]]),
    invoiceHref,
  });
}

/** The workspace's statement links: two live, one expired. */
export function statementLinksShot(): StatementLinkView[] {
  const name = new Map(BILLS_COUNTERPARTIES.map((counterparty) => [counterparty.id, counterparty.name]));
  return statementLinkRows(
    [
      { id: uuid(6001), counterpartyId: ACME.counterparty_id, createdBy: MEMBER, createdAt: "2026-10-12T08:00:00Z", expiresAt: "2026-11-11T08:00:00Z", expired: false },
      { id: uuid(6002), counterpartyId: BLUEBIRD.counterparty_id, createdBy: MEMBER, createdAt: "2026-10-09T08:00:00Z", expiresAt: "2026-10-16T08:00:00Z", expired: false },
      { id: uuid(6003), counterpartyId: LUMEN.counterparty_id, createdBy: MEMBER, createdAt: "2026-09-01T08:00:00Z", expiresAt: "2026-10-01T08:00:00Z", expired: true },
    ],
    name,
    new Map([[MEMBER, "ana@northstar.example"]])
  );
}

export const PORTAL_CUSTOMERS = BILLS_COUNTERPARTIES.filter((counterparty) => counterparty.role === "client").map(({ id, name }) => ({ id, name }));

/** The retainer's pay link, as Pay on Arc opens it: 1,000.00 of 1,800.00 USDC received. */
export const PAY_PREVIEW: PayLinkPreview = {
  orgId: uuid(9100),
  invoiceId: RETAINER,
  createdBy: null,
  orgName: "Northstar Studio",
  clientName: "Acme Retail",
  amount: 1800,
  currency: "USDC",
  dueDate: "2026-10-03",
  memo: "INV-1042 · October retainer",
  status: "open",
  payTo: `0x${"5eed".repeat(10)}`,
  chain: homeChain("arc-testnet").id,
};

/** What each receivable's row says its customer said, as the page builds it. */
export function customerNotesShot(): Map<string, string> {
  const notes = new Map<string, string>();
  for (const request of WORKSPACE_REQUESTS) {
    const note = customerNote(WORKSPACE_REQUESTS.filter((other) => other.invoiceId === request.invoiceId));
    if (note) notes.set(request.invoiceId, note);
  }
  return notes;
}
