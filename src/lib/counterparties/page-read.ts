import { readAddressChecks, type AddressCheckView } from "../address-change-check";
import { asanaOnContractors } from "../asana/contractors";
import { bankAccountsOf, readPayoutPartner, type CounterpartyBankAccount } from "../bank-payouts/store";
import { db, unwrap } from "../dal";
import { readDocumentRequests } from "../document-requests/read";
import type { DocumentRequestView } from "../document-requests/rules";
import { checkEvidenceLinks, type LinkAccess } from "../evidence-links/check";
import { sentDraftsFrom, type SentDraft } from "../invoice-drafts/store";
import { ledgerReadMayBeCut, listCounterpartyEntries, listLedgerEntriesForTargets, type CounterpartyEntry, type LedgerEntry } from "../ledger";
import { linearOnContractors } from "../linear/contractors";
import type { Network } from "../network";
import { ADDRESS_ACTIONS, ADDRESS_DOMAINS, chainKey } from "../new-payee-facts";
import { chainChoiceFits, choosablePayeeChains, payeesHeldToTheirChain } from "../payee-chain-choice";
import { homeChain } from "../payee-chains";
import { earlierLookalike, lookalikes, PAYEE_LOCK_OFF, readPayeeLock, type Lookalike, type PayeeLock } from "../payee-lock";
import { listMembers } from "../platform/members";
import { listActivePayeeLinks, listWaitingInvoiceLinks, payeeLinksOf } from "../platform/payee-links";
import { listInvoicesOf, listMilestonesOf, payeeAddressBook, type CounterpartyRow, type InvoiceRow, type MilestoneRow } from "../queries";
import { receiptStatesOf, type ReceiptLinkState } from "../receipts/share";
import { readIntentsFor, type IntentsRead } from "../settlement-read";
import { readShadowMode } from "../shadow-mode";
import type { PageGrants } from "./page-grants";
import { invoiceGroups, isPayee, PAYEE_LINKS_SHOWN, paymentRows, type Part, type PayeeLinkRecord } from "./page-view";

/**
 * What a counterparty's page reads (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL13), once the page has
 * read the counterparty itself through `db()` (CL2): every other part at once, each best effort, so a part that fails says
 * "Not read" and leaves the rest. A part that waits on this counterparty's invoices and milestones starts the moment they
 * are in. Every read starts from `counterparty.id`, never from the address the page was opened at, and a read the
 * member's grants do not allow is not made at all (CL3). Reads only: nothing here writes, pays or records (CL14).
 */

/** Ids named in one read of the entries about them: the RPC answers at most 1000 rows, and few records pass 40 (CL13). */
export const ENTRY_ID_CHUNK = 25;
/** History's lines (CL11). */
export const HISTORY_SHOWN = 25;
/** Documents' "Invoices sent for review" (CL10). */
export const DRAFTS_SHOWN = 20;

/** The entries about this counterparty's invoices and milestones, newest first. */
export interface EntriesRead {
  entries: LedgerEntry[];
  /**
   * The ids read in a chunk that may have been cut at the row cap (`ledgerReadMayBeCut`): what the entries do not say of
   * them is unknown, not absent, so their rows say "Some of this record's history was not read" (CL13).
   */
  cut: ReadonlySet<string>;
}

/** What Copy address and the confirm form are decided from (CL5). */
export interface AddressRead {
  /** The other counterparties whose address is this one, or made to look like it, on the same chain (PL6). */
  lookalikes: Lookalike[];
  /** An address this payee had or was paid at before that this one is made to look like (PL6); null for none. */
  earlierLookalike: string | null;
  /** Its contact on file said they did not make the change (AC3): from the row itself. */
  frozen: boolean;
}

/** The Payee link section, for a writer on a payee's page (CL6). */
export interface PayeeLinksRead {
  /** The latest five, newest first, never their token's hash. */
  links: PayeeLinkRecord[];
  /** The link out now, and a used one still waiting for its invoice, as Counterparties reads them for `PayeeLinkControl`. */
  active: { id: string; expiresAt: string } | null;
  waiting: { id: string; until: string } | null;
  /** Who made each link: "Made by {email}". */
  members: Array<{ userId: string; email: string }>;
}

/** What a payee's milestone cards check their evidence with (CL7), as Contractors does; none for a client. */
export interface MilestoneEvidence {
  asana: Awaited<ReturnType<typeof asanaOnContractors>>;
  linear: Awaited<ReturnType<typeof linearOnContractors>>;
  links: Map<string, LinkAccess>;
}

/** What the controls Counterparties shows in a row need here too, each best effort as on the list. */
export interface ControlsRead {
  /** Shadow mode is on, so a writer may give a payee with no address a mirror one (shadow mode S7). */
  shadow: boolean;
  /** The chains a vendor's payee link may let it choose among (payee invoice link P1, P2): none unless that fits. */
  chainChoices: string[];
  /** A vendor's bank account, on a deployment where BlindPay pays (bank payouts B4); null otherwise. */
  bank: { account: CounterpartyBankAccount | null; setUp: boolean } | null;
}

/**
 * The page's parts. A part that does not apply to this counterparty's role, or that the member's grants do not let them
 * see, is null: it was not read, and its section is not shown (CL1, CL3).
 */
export interface CounterpartyPageRead {
  /** Every invoice of theirs, both ways (CL8, CL9). */
  invoices: Part<InvoiceRow[]>;
  /** A payee's milestones (CL7). */
  milestones: Part<MilestoneRow[]> | null;
  entries: Part<EntriesRead>;
  /** The payment intents of their invoices and milestones, with where each was sent (CL9). */
  payments: Part<IntentsRead>;
  /** A payee's paid bills' receipts, for those Payments can show (CL9). */
  receipts: Part<Map<string, ReceiptLinkState>> | null;
  address: Part<AddressRead>;
  /** "Was this you?" and the freeze, for `AddressCheckNote` (AC5); null for none. */
  addressCheck: AddressCheckView | null;
  /** Read for every role, as Contractors reads it; off when it cannot be read (CL5). */
  payeeLock: PayeeLock;
  payeeLinks: Part<PayeeLinksRead> | null;
  /** A payee's milestones' evidence links, checked (CL7). */
  evidence: MilestoneEvidence;
  /** The document requests on a payee's shown bills (CL10), by invoice id. */
  documents: Part<Map<string, DocumentRequestView>> | null;
  /**
   * A payee's drafts sent for review (CL10), from the browser extension or through their payee link: not read before
   * migration 0121.
   */
  drafts: Part<SentDraft[]> | null;
  history: Part<CounterpartyEntry[]>;
  controls: ControlsRead;
}

export interface PageReadOptions {
  /** The workspace in scope, which every platform read names (CL2). */
  orgId: string;
  grants: PageGrants;
  network: Network;
  now: number;
  /** Every payment asked for (`?history=all#payments`): Payments can show 500, not 10 (CL9). */
  history: boolean;
  /** BlindPay is set up on this deployment (bank payouts B4). */
  bankPayouts: boolean;
}

/**
 * One part, best effort (CL13). A part that fails is logged by its name and the error's name only (CL4): never the
 * counterparty's name or address, which an error's message may carry.
 */
async function part<T>(name: string, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { read: true, value: await read() };
  } catch (error) {
    console.error(`counterparty page: ${name} not read`, error instanceof Error ? error.name : "unknown");
    return { read: false };
  }
}

/** A part that waits on another, not read because that one was not. */
const notRead = { read: false } as const;

/** The same, for a read whose failure the page shows as it shows nothing, as Counterparties does. */
async function quietly<T>(name: string, read: () => Promise<T>, otherwise: T): Promise<T> {
  const got = await part(name, read);
  return got.read ? got.value : otherwise;
}

const NO_EVIDENCE: MilestoneEvidence = { asana: null, linear: null, links: new Map() };

/**
 * The entries about these invoices and milestones (CL13), `ENTRY_ID_CHUNK` ids a read, merged newest first: the RPC
 * answers 1000 rows at most, so a chunk that comes back full may have left older entries out, and its ids are named.
 */
async function entriesFor(ids: { invoiceIds: string[]; milestoneIds: string[] }): Promise<EntriesRead> {
  const targets = [...ids.invoiceIds.map((id) => ({ kind: "invoice" as const, id })), ...ids.milestoneIds.map((id) => ({ kind: "milestone" as const, id }))];
  const chunks = Array.from({ length: Math.ceil(targets.length / ENTRY_ID_CHUNK) }, (_, index) => targets.slice(index * ENTRY_ID_CHUNK, (index + 1) * ENTRY_ID_CHUNK));
  const read = await Promise.all(
    chunks.map(async (chunk) => ({
      chunk,
      entries: await listLedgerEntriesForTargets({
        invoiceIds: chunk.filter((target) => target.kind === "invoice").map((target) => target.id),
        milestoneIds: chunk.filter((target) => target.kind === "milestone").map((target) => target.id),
      }),
    }))
  );
  const bySeq = new Map<number, LedgerEntry>();
  const cut = new Set<string>();
  for (const { chunk, entries } of read) {
    for (const entry of entries) bySeq.set(entry.seq, entry);
    if (ledgerReadMayBeCut(entries)) for (const target of chunk) cut.add(target.id);
  }
  return { entries: [...bySeq.values()].sort((a, b) => b.seq - a.seq), cut };
}

/**
 * The paid bills Payments can show (CL9), whose receipts are read and no others. Payments merges paid milestones into
 * them, which can only push a bill out of the latest 10 (or 500), never bring in one that is not among the latest 10 (or
 * 500) bills by the same order.
 */
function receiptIdsOf(invoices: readonly InvoiceRow[], role: string, all: boolean): string[] {
  const paid = invoiceGroups(invoices, role).paid;
  return paymentRows({ milestones: [], invoices: paid }, all).shown.flatMap((row) => (row.kind === "invoice" ? [row.invoice.id] : []));
}

/** An address entry's three addresses, read as such: never the rest of the entry's detail (CL4). */
type AddressEntryRow = { action: string; from_address: string | null; to_address: string | null; address: string | null };

const ADDRESS_ENTRY_PAGE = 1000;

/**
 * Every address this counterparty's own entries name (the ones `loadNewPayeeFacts` reads: set, confirmed or asked for),
 * newest first, a page at a time: what an earlier lookalike is looked for among.
 */
async function addressEntriesOf(counterpartyId: string): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  const rows: AddressEntryRow[] = [];
  for (let from = 0; ; from += ADDRESS_ENTRY_PAGE) {
    const page = unwrap(
      await db()
        .from("ledger_entries")
        .select("action, from_address:detail->>from, to_address:detail->>to, address:detail->>address")
        .in("domain", ADDRESS_DOMAINS)
        .in("action", ADDRESS_ACTIONS)
        .eq("detail->>counterpartyId", counterpartyId)
        .order("seq", { ascending: false })
        .range(from, from + ADDRESS_ENTRY_PAGE - 1)
    ) as AddressEntryRow[];
    rows.push(...page);
    if (page.length < ADDRESS_ENTRY_PAGE) break;
  }
  return rows.map((row) => ({ action: row.action, detail: { from: row.from_address, to: row.to_address, address: row.address } }));
}

/**
 * CL5: the other counterparties this address is, or looks like, compared on the chain each is paid on, as Counterparties
 * compares them (PL6), with this row as the page read it; and an address this payee had, or was paid at on its chain now,
 * that it is made to look like. The addresses it was paid at are its own confirmed payments' destinations, from the
 * payments this page reads (the same set `loadNewPayeeFacts` finds across the workspace's every payment).
 */
async function addressOf(counterparty: CounterpartyRow, network: Network, payments: IntentsRead): Promise<AddressRead> {
  const frozen = Boolean(counterparty.frozen_at);
  if (!counterparty.address) return { lookalikes: [], earlierLookalike: null, frozen };
  const [book, entries] = await Promise.all([payeeAddressBook(), addressEntriesOf(counterparty.id)]);
  const home = homeChain(network).id;
  const rows = [...book.filter((row) => row.id !== counterparty.id), counterparty].map((row) => ({ id: row.id, name: row.name, address: row.address, chain: row.chain ?? home }));
  const chain = chainKey(counterparty.chain);
  const paidTo = [...payments.payments.values()].flatMap((payment) => {
    const destination = payments.destinations.get(payment.source_id);
    return payment.status === "confirmed" && destination && chainKey(payment.destination_chain) === chain ? [destination.toLowerCase()] : [];
  });
  return {
    lookalikes: lookalikes(rows).get(counterparty.id) ?? [],
    earlierLookalike: earlierLookalike(counterparty.address, entries, paidTo),
    frozen,
  };
}

/** Each milestone's evidence links, checked before its card offers them (CL7, evidence access E1), as Contractors does. */
async function evidenceOf(milestones: readonly MilestoneRow[]): Promise<MilestoneEvidence> {
  if (milestones.length === 0) return NO_EVIDENCE;
  const ids = milestones.map((milestone) => milestone.id);
  const [asana, linear] = await Promise.all([asanaOnContractors(ids), linearOnContractors(ids)]);
  // The open milestones' first: the check stops at its own limit (25).
  const done = (milestone: MilestoneRow) => milestone.status === "paid" || milestone.status === "closed";
  const hrefs = [...milestones.filter((milestone) => !done(milestone)), ...milestones.filter(done)].flatMap((milestone) => [
    ...(milestone.verification_source?.startsWith("https://") ? [milestone.verification_source] : []),
    ...(asana?.links.get(milestone.id)?.deliverables.flatMap((item) => (item.href ? [item.href] : [])) ?? []),
    ...(linear?.links.get(milestone.id)?.deliverables.flatMap((item) => (item.href ? [item.href] : [])) ?? []),
  ]);
  const links = await quietly("evidence links", () => checkEvidenceLinks(hrefs), new Map<string, LinkAccess>());
  return { asana, linear, links };
}

/**
 * The chains a vendor with no address may be let choose among on its link, as Counterparties offers them (payee invoice
 * link P1, P2): none when it has an address, or a milestone or a bill in another currency holds it to its chain.
 */
async function chainChoicesOf(counterparty: CounterpartyRow): Promise<string[]> {
  if (!chainChoiceFits(counterparty, new Set())) return [];
  const labels = (await quietly("payee chains", () => choosablePayeeChains(), [])).map((chain) => chain.label);
  if (labels.length < 2) return [];
  // As if it were held when that cannot be read, as the list does.
  const held = await quietly("payees held to their chain", () => payeesHeldToTheirChain([counterparty.id]), new Set([counterparty.id]));
  return chainChoiceFits(counterparty, held) ? labels : [];
}

export async function readCounterpartyPage(counterparty: CounterpartyRow, options: PageReadOptions): Promise<CounterpartyPageRead> {
  const { orgId, grants, network, now } = options;
  const id = counterparty.id;
  const payee = isPayee(counterparty.role);

  const invoicesRead = part("invoices", () => listInvoicesOf(id));
  const milestonesRead = payee ? part("milestones", () => listMilestonesOf(id)) : Promise.resolve(null);
  // What waits on the records: the ids of every one read.
  const recordsRead = Promise.all([invoicesRead, milestonesRead]);
  const idsRead = recordsRead.then(([invoices, milestones]) => ({
    invoiceIds: invoices.read ? invoices.value.map((invoice) => invoice.id) : [],
    milestoneIds: milestones?.read ? milestones.value.map((milestone) => milestone.id) : [],
  }));
  const entriesRead = idsRead.then((ids) => part("entries", () => entriesFor(ids)));
  const paymentsRead = idsRead.then((ids) => part("payment intents", () => readIntentsFor(db(), ids)));
  const receiptsRead = payee
    ? invoicesRead.then((invoices) => (invoices.read ? part("receipts", () => receiptStatesOf(receiptIdsOf(invoices.value, counterparty.role, options.history))) : notRead))
    : Promise.resolve(null);
  // Copy address shows only on every fact read (CL5): with the records or their payments unread, the addresses this
  // payee was paid at are not known, and nothing is copied on a guess.
  const addressRead = Promise.all([recordsRead, paymentsRead]).then(([[invoices, milestones], payments]) =>
    invoices.read && (milestones === null || milestones.read) && payments.read ? part("address", () => addressOf(counterparty, network, payments.value)) : notRead
  );
  // The document requests on the bills Bills from them shows: open ones and the latest rejected (CL8, CL10).
  const documentsRead = payee
    ? invoicesRead.then((invoices) => {
        if (!invoices.read) return notRead;
        const groups = invoiceGroups(invoices.value, counterparty.role);
        return part("document requests", () => readDocumentRequests([...groups.open.rows, ...groups.closed.rows].map((invoice) => invoice.id), db(), now));
      })
    : Promise.resolve(null);
  const evidenceRead = milestonesRead.then((milestones) => (milestones?.read ? evidenceOf(milestones.value) : NO_EVIDENCE));
  // The payee links, the payee's own only, and only for whoever may send them (CL3, CL6): a platform table, read naming
  // the workspace and the payee (CL2).
  const payeeLinksRead =
    payee && grants.seeLinks
      ? part("payee links", async () => {
          const [links, active, waiting, members] = await Promise.all([
            payeeLinksOf(orgId, id, PAYEE_LINKS_SHOWN),
            listActivePayeeLinks(orgId, now, { counterpartyId: id }),
            listWaitingInvoiceLinks(orgId, now, { counterpartyId: id }),
            listMembers(orgId),
          ]);
          return { links, active: active.get(id) ?? null, waiting: waiting.get(id) ?? null, members: members.map((member) => ({ userId: member.userId, email: member.email })) };
        })
      : Promise.resolve(null);

  const [invoices, milestones, entries, payments, receipts, address, addressCheck, payeeLock, payeeLinks, evidence, documents, drafts, history, shadow, chainChoices, bank] =
    await Promise.all([
      invoicesRead,
      milestonesRead,
      entriesRead,
      paymentsRead,
      receiptsRead,
      addressRead,
      // A freeze unread is still the row's: its notice and Unfreeze stay (AC5).
      quietly("address checks", async () => (await readAddressChecks([id], db(), now)).get(id) ?? null, counterparty.frozen_at ? { frozen: true, check: null } : null),
      quietly("payee lock", () => readPayeeLock(db()), PAYEE_LOCK_OFF),
      payeeLinksRead,
      evidenceRead,
      documentsRead,
      payee ? part("drafts", () => sentDraftsFrom(id, DRAFTS_SHOWN)) : Promise.resolve(null),
      part("history", () => listCounterpartyEntries(id, HISTORY_SHOWN)),
      // A mirror address is offered to a writer, for a payee with none (shadow mode S7).
      grants.write && payee && !counterparty.address ? quietly("shadow mode", async () => (await readShadowMode(db())) !== null, false) : Promise.resolve(false),
      grants.write && payee ? chainChoicesOf(counterparty) : Promise.resolve([]),
      options.bankPayouts && counterparty.role === "vendor"
        ? Promise.all([
            quietly("bank account", async () => (await bankAccountsOf([id])).get(id) ?? null, null),
            quietly("payout partner", () => readPayoutPartner(), null),
          ]).then(([account, partner]) => ({ account, setUp: Boolean(partner?.customerId) }))
        : Promise.resolve(null),
    ]);

  return { invoices, milestones, entries, payments, receipts, address, addressCheck, payeeLock, payeeLinks, evidence, documents, drafts, history, controls: { shadow, chainChoices, bank } };
}
