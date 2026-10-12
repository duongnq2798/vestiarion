import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePosting,
  confirmInFlight,
  draftPostings,
  type BookingStore,
  type Candidate,
  type NewPosting,
  type PostingPatch,
  type PostingRow,
} from "@/lib/connectors/booking-run";
import type { Connection, PaymentAccount } from "@/lib/connectors/connections";
import { postingFingerprint, REALITY_REFUSAL, type PostingState } from "@/lib/connectors/posting";
import { ProviderError, type BookingProvider, type ExternalBill, type ExternalPayment, type OrganisationFacts } from "@/lib/connectors/provider";
import type { LedgerEntryInput } from "@/lib/ledger";

/**
 * Booking payments made on Arc, run by run (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W3, W6,
 * W7, W9), with a fake provider and an in-memory store that holds the database's own rules (one booking per payable,
 * the transitions, the reality check): drafting, approving and sending, and the read-back.
 */

const NOW = Date.parse("2026-10-12T09:30:00.000Z");
const HASH = `0x${"3c".repeat(32)}`;
const BILL = "0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0101";
const ACCOUNT: PaymentAccount = { id: "6f7594f2-f059-4d56-9e67-47ac9733bfe9", code: "091", name: "Arc USDC wallet", currency: "USD" };
const DEMO: OrganisationFacts = { externalOrgId: "tenant-1", name: "Demo Company (Global)", demo: true, baseCurrency: "USD" };
const REAL: OrganisationFacts = { externalOrgId: "tenant-1", name: "Northwind Trading Pte Ltd", demo: false, baseCurrency: "USD" };
const SHOWN = { amountDue: "31.39", status: "open" as const };

const connection: Connection = {
  id: "conn-1",
  orgId: "org-1",
  provider: "xero",
  externalOrgId: "tenant-1",
  externalOrgName: "Demo Company (Global)",
  status: "connected",
  scopes: ["offline_access", "accounting.invoices.read", "accounting.contacts.read", "accounting.settings.read", "accounting.payments"],
  connectedBy: "user-1",
  connectedAt: "2026-10-12T07:00:00.000Z",
  consentVersion: "xero-2026-10-12.2",
  consentedAt: "2026-10-12T07:00:00.000Z",
  revokedAt: null,
  windowFrom: "2026-07-14",
  lastSyncedAt: null,
  lastError: null,
  lastErrorAt: null,
  failures: 0,
  nextSyncAfter: null,
  syncLeaseUntil: null,
  paymentAccount: ACCOUNT,
  paymentAccountAt: "2026-10-12T07:10:00.000Z",
};

const ALLOWED: Record<PostingState, PostingState[]> = {
  draft: ["sending", "refused"],
  failed: ["sending", "refused"],
  sending: ["draft", "failed", "sent", "refused"],
  sent: ["confirmed", "failed", "refused"],
  confirmed: [],
  refused: [],
};

/** The database's rules, in memory. */
function memoryStore(candidates: Candidate[] = [], shadow = true) {
  const rows = new Map<string, PostingRow>();
  const entries: LedgerEntryInput[] = [];
  let next = 1;
  const store: BookingStore = {
    candidates: async () => candidates.filter((candidate) => ![...rows.values()].some((row) => row.invoiceId === candidate.invoiceId)),
    shadowOn: async () => shadow,
    insert: async (_connection, posting: NewPosting) => {
      if ([...rows.values()].some((row) => row.invoiceId === posting.invoiceId)) return null;
      const row: PostingRow = {
        id: `posting-${next++}`,
        connectionId: connection.id,
        provider: "xero",
        externalOrgId: connection.externalOrgId,
        invoiceId: posting.invoiceId,
        billExternalId: posting.billExternalId,
        ...posting.facts,
        network: posting.network,
        shadow: posting.shadow,
        organisationDemo: posting.organisationDemo,
        state: posting.state,
        reason: posting.reason,
        message: posting.message,
        account: null,
        fingerprint: null,
        attempts: 0,
        externalPaymentId: null,
        sendingUntil: null,
        approvedBy: null,
        approvedAt: null,
        sentAt: null,
        confirmedAt: null,
        createdAt: new Date(NOW).toISOString(),
      };
      rows.set(row.id, row);
      return { ...row };
    },
    move: async (posting, from, to, patch: Partial<PostingPatch>, options) => {
      const row = rows.get(posting.id);
      if (!row) return null;
      if (!from.includes(row.state)) return null;
      // A claim takes a booking being sent only once that send's lease ran out.
      if (row.state === "sending" && options?.leaseOverAt !== undefined && row.sendingUntil !== null && row.sendingUntil > options.leaseOverAt) return null;
      if (patch.attempts !== undefined && row.attempts !== posting.attempts) return null;
      if (to !== row.state && !ALLOWED[row.state].includes(to)) throw new Error(`accounting_posting_transition: ${row.state} to ${to}`);
      const after: PostingRow = { ...row, ...patch, state: to };
      if (["sending", "sent", "confirmed"].includes(to) && !(after.network === "arc-mainnet" && !after.shadow) && after.organisationDemo !== true) {
        throw new Error("accounting_postings_reality_check");
      }
      rows.set(row.id, after);
      return { ...after };
    },
    inFlight: async (_connectionId, nowIso) => [...rows.values()].filter((row) => row.state === "sent" || (row.state === "sending" && (row.sendingUntil ?? "") <= nowIso)),
    record: async (entry) => {
      entries.push(entry);
    },
  };
  return { store, rows, entries };
}

const openBill = (fields: Partial<ExternalBill> = {}): ExternalBill => ({
  externalId: BILL,
  version: "2026-10-12T08:00:00.000Z",
  updatedAt: "2026-10-12T08:00:00.000Z",
  contactExternalId: "c-1",
  contactName: "Xero",
  number: "Inv-2026-10",
  reference: null,
  currency: "USD",
  total: "31.39",
  amountDue: "31.39",
  issuedOn: "2026-10-01",
  dueOn: "2026-10-20",
  status: "open",
  ...fields,
});

const made = (fields: Partial<ExternalPayment> = {}): ExternalPayment => ({
  externalId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379",
  billExternalId: BILL,
  accountExternalId: ACCOUNT.id,
  amount: "31.39",
  currency: "USD",
  date: "2026-10-12",
  reference: HASH,
  status: "active",
  ...fields,
});

function fakeXero(overrides: Partial<Record<keyof BookingProvider, unknown>> = {}) {
  const calls: string[] = [];
  const booking = {
    writeScopes: ["accounting.payments"],
    organisation: vi.fn(async () => {
      calls.push("organisation");
      return DEMO;
    }),
    bill: vi.fn(async () => {
      calls.push("bill");
      return openBill();
    }),
    findPayment: vi.fn(async (): Promise<ExternalPayment | null> => {
      calls.push("find");
      return null;
    }),
    bookPayment: vi.fn(async () => {
      calls.push("book");
      return { ok: true as const, payment: made() };
    }),
    payment: vi.fn(async () => {
      calls.push("read");
      return made();
    }),
    ...overrides,
  } as unknown as BookingProvider & Record<string, ReturnType<typeof vi.fn>>;
  return { booking, calls };
}

const candidate = (fields: Partial<Candidate> = {}): Candidate => ({
  invoiceId: "inv-1",
  billExternalId: BILL,
  network: "arc-testnet",
  invoice: { amount: 31.39, currency: "USDC", paidAmount: 31.39, originalCurrency: "USD", originalAmount: 31.39, txRef: HASH, settledAt: "2026-10-12T09:15:00.000Z" },
  intent: { txHash: HASH, confirmedAt: "2026-10-12T09:14:41.000Z", feeUsd: 0.0021, bridgeFee: null },
  bill: { currency: "USD", sourceStatus: "open", amountDue: "31.39", number: "Inv-2026-10", contactName: "Xero" },
  ...fields,
});

const deps = (store: BookingStore, booking: BookingProvider) => ({ connection, booking, label: "Xero", store, now: () => NOW, accessToken: async () => "token" });
const fingerprint = (row: PostingRow, account = ACCOUNT, shown = SHOWN) =>
  postingFingerprint({ billExternalId: row.billExternalId, bill: shown, amount: row.amount, currency: row.currency, accountId: account.id, paidOn: row.paidOn, reference: row.reference });

async function drafted(options: { candidate?: Partial<Candidate>; shadow?: boolean; organisation?: OrganisationFacts } = {}) {
  const world = memoryStore([candidate(options.candidate)], options.shadow ?? true);
  const xero = fakeXero({ organisation: vi.fn(async () => options.organisation ?? DEMO) });
  await draftPostings(deps(world.store, xero.booking));
  const row = [...world.rows.values()][0];
  return { ...world, xero, row };
}

const approve = (world: ReturnType<typeof memoryStore>, booking: BookingProvider, row: PostingRow, fields: Partial<Parameters<typeof approvePosting>[0]> = {}) =>
  approvePosting({
    deps: deps(world.store, booking),
    accessToken: "token",
    organisation: DEMO,
    posting: { ...world.rows.get(row.id)! },
    shownBill: SHOWN,
    account: ACCOUNT,
    shownFingerprint: fingerprint(row),
    by: "user-1",
    ...fields,
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("draftPostings (W3)", () => {
  it("drafts a shadow payment on Arc testnet for a demo organisation, and records it", async () => {
    const { row, entries } = await drafted();
    expect(row).toMatchObject({ state: "draft", amount: "31.39", currency: "USD", paidOn: "2026-10-12", reference: HASH, network: "arc-testnet", shadow: true, organisationDemo: true, networkFee: "0.0021" });
    expect(entries.map((entry) => entry.action)).toEqual(["accounting_payment_drafted"]);
    expect(entries[0]).toMatchObject({ actor: "system", domain: "ap", detail: { invoiceId: "inv-1", postingId: row.id, billId: BILL, network: "arc-testnet", shadow: true } });
  });

  it("refuses a shadow payment for a real organisation at once, in the rule's words, and never sends it", async () => {
    const { row, entries, xero } = await drafted({ organisation: REAL });
    expect(row).toMatchObject({ state: "refused", reason: "reality", message: REALITY_REFUSAL, organisationDemo: false });
    expect(entries.map((entry) => entry.action)).toEqual(["accounting_payment_refused"]);
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
  });

  it("refuses a payment on Arc testnet outside shadow mode for a real organisation too", async () => {
    const { row } = await drafted({ shadow: false, candidate: { invoice: { ...candidate().invoice, originalCurrency: null, originalAmount: null } }, organisation: REAL });
    expect(row).toMatchObject({ state: "refused", reason: "reality", shadow: false });
  });

  it("drafts a payment on Arc mainnet outside shadow mode for a real organisation, without needing to read it", async () => {
    const world = memoryStore([candidate({ network: "arc-mainnet", invoice: { ...candidate().invoice, originalCurrency: null, originalAmount: null } })], false);
    const xero = fakeXero({ organisation: vi.fn(async () => REAL) });
    await draftPostings(deps(world.store, xero.booking));
    expect([...world.rows.values()][0]).toMatchObject({ state: "draft", network: "arc-mainnet", shadow: false });
    expect(xero.booking.organisation).not.toHaveBeenCalled();
  });

  it("drafts nothing that needs the organisation while it cannot be read, and tries again next run", async () => {
    const world = memoryStore([candidate()]);
    const xero = fakeXero({ organisation: vi.fn(async () => Promise.reject(new ProviderError("unavailable", "Xero organisation: 503"))) });
    expect(await draftPostings(deps(world.store, xero.booking))).toEqual({ drafted: 0, refused: 0, waiting: 1 });
    expect(world.rows.size).toBe(0);
  });

  it("refuses a bill the last sync saw paid in Xero: already paid there", async () => {
    const { row } = await drafted({ candidate: { bill: { ...candidate().bill!, sourceStatus: "paid", amountDue: "0" } } });
    expect(row).toMatchObject({ state: "refused", reason: "already_paid", message: "Already paid in Xero." });
  });

  it("refuses a payment in another currency than the bill's", async () => {
    const { row } = await drafted({ candidate: { bill: { ...candidate().bill!, currency: "SGD" } } });
    expect(row).toMatchObject({ state: "refused", reason: "currency" });
  });

  it("drafts each payable once, however many runs", async () => {
    const world = memoryStore([candidate()]);
    const xero = fakeXero();
    await draftPostings(deps(world.store, xero.booking));
    await draftPostings(deps(world.store, xero.booking));
    expect(world.rows.size).toBe(1);
    expect(world.entries).toHaveLength(1);
  });
});

describe("approvePosting (W6, W7)", () => {
  it("books it: looks first, checks the bill, books with the key, reads it back, and confirms", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    const result = await approve({ store, rows, entries }, xero.booking, row);
    expect(result).toEqual({ postingId: row.id, outcome: "booked", paymentId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379", message: "Booked in Xero." });
    // The organisation was read once for the approval, before it (`organisation`).
    expect(xero.calls).toEqual(["find", "bill", "book", "read"]);
    expect(xero.booking.bookPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: { billExternalId: BILL, accountExternalId: ACCOUNT.id, amount: "31.39", currency: "USD", date: "2026-10-12", reference: HASH },
        idempotencyKey: `vestiarion-booking-${row.id}-${fingerprint(row).slice(0, 16)}`,
      })
    );
    expect(rows.get(row.id)).toMatchObject({ state: "confirmed", externalPaymentId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379", account: ACCOUNT, approvedBy: "user-1", attempts: 1 });
    expect(entries.map((entry) => entry.action)).toEqual(["accounting_payment_drafted", "accounting_payment_approved", "accounting_payment_sent", "accounting_payment_confirmed"]);
    expect(entries[1]).toMatchObject({ actor: "human", detail: { by: "user-1", fingerprint: fingerprint(row), account: ACCOUNT } });
    expect(entries[2].detail).toMatchObject({ adopted: false, paymentId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379" });
  });

  it("refuses a view that changed since it was shown (stale), and sends nothing", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    const result = await approve({ store, rows, entries }, xero.booking, row, { shownFingerprint: fingerprint(row, { ...ACCOUNT, id: "another-account" }) });
    expect(result).toMatchObject({ outcome: "stale", message: "This booking changed since you saw it. Look at it again, then approve." });
    expect(xero.calls).toEqual([]);
    expect(rows.get(row.id)?.state).toBe("draft");
    expect(entries).toHaveLength(1);
  });

  it("refuses by the reality rule, read again right before sending", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    const result = await approve({ store, rows, entries }, xero.booking, row, { organisation: REAL });
    expect(result).toEqual({ postingId: row.id, outcome: "refused", message: REALITY_REFUSAL });
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
    expect(rows.get(row.id)).toMatchObject({ state: "refused", reason: "reality", organisationDemo: false });
    expect(entries.at(-1)).toMatchObject({ action: "accounting_payment_refused", detail: { reason: "reality", organisationDemo: false } });
  });

  it("sends nothing while the organisation could not be read", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    expect(await approve({ store, rows, entries }, xero.booking, row, { organisation: null })).toMatchObject({ outcome: "unavailable" });
    expect(rows.get(row.id)?.state).toBe("draft");
  });

  it("refuses a bill already paid in Xero", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.bill = vi.fn(async () => openBill({ status: "paid", amountDue: "0" }));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toEqual({ postingId: row.id, outcome: "refused", message: "Already paid in Xero." });
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
    expect(rows.get(row.id)).toMatchObject({ state: "refused", reason: "already_paid" });
  });

  it("puts a booking whose bill changed in Xero back to its draft, and sends nothing", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.bill = vi.fn(async () => openBill({ amountDue: "20.00" }));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "stale", message: "Xero now says 20.00 USD is due on this bill. Sync now, then look at this booking again." });
    expect(rows.get(row.id)?.state).toBe("draft");
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
  });

  it("adopts a payment already in Xero with this reference, and writes nothing new", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.findPayment = vi.fn(async () => made({ externalId: "already-there" }));
    xero.booking.payment = vi.fn(async () => made({ externalId: "already-there" }));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "booked", paymentId: "already-there" });
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
    expect(entries.find((entry) => entry.action === "accounting_payment_sent")?.detail).toMatchObject({ adopted: true, paymentId: "already-there" });
  });

  it("never books again a payment someone deleted in Xero", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.findPayment = vi.fn(async () => made({ status: "deleted" }));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "refused" });
    expect(rows.get(row.id)).toMatchObject({ state: "refused", reason: "deleted_in_provider" });
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
  });

  it("reads back after a timeout, and takes the payment Xero made when it is there", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    let found = false;
    xero.booking.findPayment = vi.fn(async () => (found ? made() : null));
    xero.booking.bookPayment = vi.fn(async () => {
      found = true;
      throw new ProviderError("unavailable", "Xero payment: no answer");
    });
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "booked", paymentId: made().externalId });
    expect(xero.booking.bookPayment).toHaveBeenCalledTimes(1);
    expect(rows.get(row.id)?.state).toBe("confirmed");
    expect(entries.find((entry) => entry.action === "accounting_payment_sent")?.detail).toMatchObject({ adopted: true });
  });

  it("fails a timeout whose read-back finds nothing, and the next approval looks first and books once", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.bookPayment = vi.fn(async () => Promise.reject(new ProviderError("unavailable", "Xero payment: 504")));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "failed" });
    expect(rows.get(row.id)).toMatchObject({ state: "failed", reason: "no_answer" });
    expect(entries.at(-1)).toMatchObject({ action: "accounting_payment_failed", detail: { reason: "no_answer", retryable: true } });
    // Xero had made it after all: the next approval finds it before writing anything.
    xero.booking.findPayment = vi.fn(async () => made());
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "booked" });
    expect(xero.booking.bookPayment).toHaveBeenCalledTimes(1);
    expect(rows.get(row.id)).toMatchObject({ state: "confirmed", attempts: 2 });
  });

  it("fails a refusal in Xero's words, to approve again once fixed", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.bookPayment = vi.fn(async () => ({ ok: false as const, message: "The document date cannot be before the period lock date" }));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toEqual({
      postingId: row.id,
      outcome: "failed",
      message: "Xero refused the payment: The document date cannot be before the period lock date.",
    });
    expect(rows.get(row.id)).toMatchObject({ state: "failed", reason: "refused_by_provider" });
  });

  it("books a duplicate approval once: the second finds it claimed, or booked", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    const [first, second] = await Promise.all([approve({ store, rows, entries }, xero.booking, row), approve({ store, rows, entries }, xero.booking, row)]);
    expect([first.outcome, second.outcome].sort()).toEqual(["booked", "busy"]);
    expect(xero.booking.bookPayment).toHaveBeenCalledTimes(1);
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "booked", message: "Already booked in Xero." });
    expect(xero.booking.bookPayment).toHaveBeenCalledTimes(1);
  });

  it("leaves a booking sent when the read-back gets no answer, for the next run to confirm", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.payment = vi.fn(async () => Promise.reject(new ProviderError("unavailable", "Xero payment read: 502")));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "sent" });
    expect(rows.get(row.id)?.state).toBe("sent");
    xero.booking.payment = vi.fn(async () => made());
    expect(await confirmInFlight(deps(store, xero.booking))).toEqual({ confirmed: 1, checked: 1 });
    expect(rows.get(row.id)?.state).toBe("confirmed");
  });

  it("asks to reconnect when Xero refuses the access, and to wait when it asks Vestiarion to slow down", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.bookPayment = vi.fn(async () => Promise.reject(new ProviderError("forbidden", "Xero payment: 403")));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "failed", message: expect.stringContaining("Reconnect Xero") });
    expect(rows.get(row.id)?.reason).toBe("reconnect");
    xero.booking.bookPayment = vi.fn(async () => Promise.reject(new ProviderError("rate_limited", "Xero payment: 429", 30_000)));
    expect(await approve({ store, rows, entries }, xero.booking, row)).toMatchObject({ outcome: "failed", message: expect.stringContaining("slow down") });
  });

  it("holds the reality rule even when the code above it would not: the store refuses the claim", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    // An organisation answer that says demo while the row says otherwise is still written with the claim, so a row the
    // rule refuses can never reach sending.
    const mainnetShadow = { ...rows.get(row.id)!, network: "arc-mainnet" as const };
    rows.set(row.id, mainnetShadow);
    await expect(store.move(mainnetShadow, ["draft"], "sending", { organisationDemo: false, sendingUntil: "x", account: ACCOUNT, fingerprint: "f" })).rejects.toThrow(/reality/);
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
  });
});

describe("confirmInFlight (W7)", () => {
  it("refuses a booking whose payment was deleted in Xero since it was sent", async () => {
    const { row, store, rows, entries, xero } = await drafted();
    xero.booking.payment = vi.fn(async () => Promise.reject(new ProviderError("unavailable", "no answer")));
    await approve({ store, rows, entries }, xero.booking, row);
    xero.booking.payment = vi.fn(async () => null);
    await confirmInFlight(deps(store, xero.booking));
    expect(rows.get(row.id)).toMatchObject({ state: "refused", reason: "deleted_in_provider" });
  });

  it("takes a send that stopped past its lease when Xero has it, and fails it when Xero has none", async () => {
    const world = memoryStore([candidate(), candidate({ invoiceId: "inv-2", billExternalId: "bill-2" })]);
    const xero = fakeXero();
    await draftPostings(deps(world.store, xero.booking));
    const [first, second] = [...world.rows.values()];
    for (const row of [first, second]) {
      await world.store.move(row, ["draft"], "sending", { account: ACCOUNT, fingerprint: "f".repeat(64), sendingUntil: "2026-10-12T09:00:00.000Z", organisationDemo: true, attempts: 1 });
    }
    xero.booking.findPayment = vi.fn(async (input: { billId: string }) => (input.billId === BILL ? made() : null));
    expect(await confirmInFlight(deps(world.store, xero.booking))).toEqual({ confirmed: 1, checked: 2 });
    expect(world.rows.get(first.id)?.state).toBe("confirmed");
    expect(world.rows.get(second.id)).toMatchObject({ state: "failed", reason: "no_answer" });
    expect(xero.booking.bookPayment).not.toHaveBeenCalled();
  });
});
