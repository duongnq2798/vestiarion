import { platformDb, unwrap, type OrgDb } from "./dal";
import { newPayeeCheck, type NewPayeeCheck } from "./new-payee";
import { paidAcrossChains } from "./payee-chains";

/**
 * What the new payee check reads (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N1, N2), once per stage
 * or approval: the addresses each payee asked about has received a confirmed payment at, and each counterparty's ledger
 * entries that set, confirmed or asked for its address, newest first. `newPayeeCheck` (./new-payee) decides from them.
 *
 * A first payment is keyed on the payee and the address together (independent review, 2026-10-15): a confirmed payment
 * counts for the payee its invoice or milestone was for, so an address the workspace paid for someone else is still a
 * first payment for this payee. And on the chain (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P3): a
 * payment counts only on the chain the payee is paid on now, so a first payment on Base to an address paid on Arc is
 * still a first payment. A payment's chain is the one it was minted on (`payment_intents.destination_chain`), or the
 * network's own when it has none; a payee's is its `chain`, or the network's own when it has none.
 *
 * Who asked the payee for an address they sent is read from the workspace's own signed entries, in the same read as the
 * address's: `payee_link_created` names who created a payee link, and `github_bounty_attached` the member a pull
 * request's bounty acts as. Only when a link's entry is missing is the link's own `payee_links` row read (migration 0039,
 * `created_by`), and set beside the entry as `linkCreatedBy`; the ledger's detail is left as written.
 */
export interface NewPayeeFacts {
  /** For each counterparty asked about, every address it has received a confirmed payment at on its chain now, lowercase. */
  paidTo: Map<string, Set<string>>;
  /** Each counterparty's entries that set, confirmed or asked for its address, newest first. */
  entries: Map<string, Array<{ action: string; detail: Record<string, unknown>; linkCreatedBy?: string | null }>>;
}

/** The address's own entries, and the signed entries that name who asked the payee for one (./new-payee). */
const ADDRESS_ACTIONS = [
  "create_counterparty",
  "counterparty_address_changed",
  "counterparty_address_confirmed",
  "payee_link_created",
  "github_bounty_attached",
];
/** `payee_link_created` is a compliance entry; `github_bounty_attached` a contractor one. */
const ADDRESS_DOMAINS = ["compliance", "contractor"];

const NONE: ReadonlySet<string> = new Set();

/** The check for a payment to this counterparty at its address (N1, N3), from facts loaded for it. */
export function newPayeeCheckFor(facts: NewPayeeFacts, counterparty: { id: string; address: string | null }): NewPayeeCheck | null {
  return newPayeeCheck({ address: counterparty.address, paidTo: facts.paidTo.get(counterparty.id) ?? NONE, entries: facts.entries.get(counterparty.id) ?? [] });
}

/** The check when paying this counterparty at its address would be its first payment there; null otherwise. */
export function firstPaymentFrom(facts: NewPayeeFacts, counterparty: { id: string; address: string | null }): NewPayeeCheck | null {
  const check = newPayeeCheckFor(facts, counterparty);
  return check?.firstPayment ? check : null;
}

/**
 * For the follow-up (N7): whether a payable held as a new payee has since been paid at its address, and whether two
 * parties now stand behind the address; null for a counterparty with no address.
 */
export function newPayeeFollowUp(facts: NewPayeeFacts, counterparty: { id: string; address: string | null }): { addressPaid: boolean; twoParties: boolean } | null {
  const check = newPayeeCheckFor(facts, counterparty);
  return check ? { addressPaid: !check.firstPayment, twoParties: check.twoParties } : null;
}

/**
 * For a person's payment (new payee check N4): the check when paying this counterparty would be its first payment at
 * its address; null otherwise, or when it has no address. The caller asks only where payments are real (N5).
 */
export async function firstPaymentCheck(db: OrgDb, counterparty: { id: string; address: string | null }): Promise<NewPayeeCheck | null> {
  if (!counterparty.address) return null;
  return firstPaymentFrom(await loadNewPayeeFacts(db, [counterparty.id]), counterparty);
}

export async function loadNewPayeeFacts(db: OrgDb, counterpartyIds: readonly string[]): Promise<NewPayeeFacts> {
  const paidTo = new Map<string, Set<string>>();
  const entries: NewPayeeFacts["entries"] = new Map();
  if (counterpartyIds.length === 0) return { paidTo, entries };
  const ids = [...counterpartyIds];

  for (const [counterpartyId, address] of await confirmedPayments(db, ids)) {
    const set = paidTo.get(counterpartyId);
    if (set) set.add(address);
    else paidTo.set(counterpartyId, new Set([address]));
  }

  const rows = await addressEntries(db, ids);
  const creators = await linkRowCreators(db.orgId, rows);
  for (const row of rows) {
    const id = row.detail.counterpartyId;
    if (typeof id !== "string") continue;
    const linkId = viaLink(row);
    const entry = linkId !== null && creators.has(linkId) ? { ...row, linkCreatedBy: creators.get(linkId) ?? null } : row;
    const list = entries.get(id);
    if (list) list.push(entry);
    else entries.set(id, [entry]);
  }
  return { paidTo, entries };
}

/** How many confirmed payments are read at a time: PostgREST's row cap, so no page is ever cut short by it. */
export const PAYMENT_PAGE = 1000;
/** How many invoice or milestone ids one read names, to keep its address short. */
export const ID_CHUNK = 100;

type EntryRow = { action: string; detail: Record<string, unknown> };

/**
 * These counterparties' entries that set, confirmed or asked for an address, newest first, a page at a time, so the row
 * cap never drops the oldest. An entry written meanwhile only shifts a later page: one entry read twice, none missed,
 * and the newest entry that set the address is still read first.
 */
async function addressEntries(db: OrgDb, ids: string[]): Promise<EntryRow[]> {
  const rows: EntryRow[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE) {
    const page = unwrap(
      await db
        .from("ledger_entries")
        .select("action, detail")
        .in("domain", ADDRESS_DOMAINS)
        .in("action", ADDRESS_ACTIONS)
        .in("detail->>counterpartyId", ids)
        .order("seq", { ascending: false })
        .range(from, from + PAYMENT_PAGE - 1)
    ) as EntryRow[];
    rows.push(...page);
    if (page.length < PAYMENT_PAGE) return rows;
  }
}

type PaymentRow = { source_type: string; source_id: string; destination: string | null; destination_chain?: string | null };

/** The network's own chain, however it is named, as the check compares chains. */
const OWN_CHAIN = "own";

/** A chain as the check compares it (P3): the network's own chain, named or not, is one; any other is itself. */
export function chainKey(chain: string | null | undefined): string {
  if (!chain) return OWN_CHAIN;
  try {
    return paidAcrossChains(chain) ? chain : OWN_CHAIN;
  } catch {
    // A chain no network lists is never the network's own.
    return chain;
  }
}

/**
 * Each of these counterparties' chain now, as `chainKey` gives it, read by id in chunks. One not read is on its network's
 * own: a payment minted on another chain then never counts for it, so the check errs towards a first payment.
 */
async function payeeChains(db: OrgDb, ids: string[]): Promise<Map<string, string>> {
  const chains = new Map<string, string>();
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const found = await db.from("counterparties").select("id, chain").in("id", ids.slice(start, start + ID_CHUNK));
    if (found.error) throw new Error(found.error.message);
    const rows = Array.isArray(found.data) ? (found.data as Array<{ id: string; chain?: string | null }>) : [];
    for (const row of rows) chains.set(row.id, chainKey(row.chain));
  }
  return chains;
}

/** Every confirmed payment of the workspace, a page at a time in a stable order, so the row cap never drops one. */
async function allConfirmedPayments(db: OrgDb): Promise<PaymentRow[]> {
  const rows: PaymentRow[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE) {
    const page = unwrap(
      await db
        .from("payment_intents")
        .select("source_type, source_id, destination, destination_chain")
        .eq("status", "confirmed")
        .order("id", { ascending: true })
        .range(from, from + PAYMENT_PAGE - 1)
    ) as PaymentRow[];
    rows.push(...page);
    if (page.length < PAYMENT_PAGE) return rows;
  }
}

/** Which of these counterparties each invoice or milestone id belongs to, read by id in chunks: none is dropped. */
async function payeesOf(db: OrgDb, table: "invoices" | "milestones", sourceIds: string[], ids: string[]): Promise<Array<[string, string]>> {
  const column = table === "invoices" ? "counterparty_id" : "contractor_id";
  const found: Array<[string, string]> = [];
  for (let start = 0; start < sourceIds.length; start += ID_CHUNK) {
    const rows = unwrap(
      await db.from(table).select(`id, ${column}`).in("id", sourceIds.slice(start, start + ID_CHUNK)).in(column, ids)
    ) as Array<Record<string, string>>;
    for (const row of rows) found.push([row.id, row[column]]);
  }
  return found;
}

/**
 * Each confirmed payment to these counterparties on the chain each is paid on now, as `[counterpartyId, address]`, the
 * address lowercase. A payment is read as its invoice's or milestone's payee's. Which payee a payment was for, and the
 * chain each payee is paid on, are asked only when a payment was confirmed for one.
 */
async function confirmedPayments(db: OrgDb, ids: string[]): Promise<Array<[string, string]>> {
  const withAddress = (await allConfirmedPayments(db)).filter((row) => typeof row.destination === "string" && row.destination.length > 0);
  if (withAddress.length === 0) return [];
  const sources = (type: string) => [...new Set(withAddress.filter((row) => row.source_type === type).map((row) => row.source_id))];
  const payeeOf = new Map<string, string>();
  for (const [id, payee] of await payeesOf(db, "invoices", sources("invoice"), ids)) payeeOf.set(`invoice:${id}`, payee);
  for (const [id, payee] of await payeesOf(db, "milestones", sources("milestone"), ids)) payeeOf.set(`milestone:${id}`, payee);
  if (payeeOf.size === 0) return [];
  const chains = await payeeChains(db, [...new Set(payeeOf.values())]);
  return withAddress.flatMap((row): Array<[string, string]> => {
    const payee = payeeOf.get(`${row.source_type}:${row.source_id}`);
    if (!payee || chainKey(row.destination_chain) !== (chains.get(payee) ?? OWN_CHAIN)) return [];
    return [[payee, (row.destination as string).toLowerCase()]];
  });
}

/** The payee link an entry's address was sent through, or null for an address given any other way. */
function viaLink(row: { action: string; detail: Record<string, unknown> }): string | null {
  return row.action !== "payee_link_created" && row.detail.via === "payee_link" && typeof row.detail.linkId === "string" ? row.detail.linkId : null;
}

/**
 * Who created each payee link these entries name whose signed `payee_link_created` entry is missing, from the links'
 * own rows in this workspace. `payee_links` is a platform table (0039): only the service role reads it, so it is read
 * here through `platformDb`, always naming the workspace. Nothing is read when every link has its entry. A link not
 * found, or whose creator's account is gone, names no one.
 */
async function linkRowCreators(orgId: string, rows: ReadonlyArray<{ action: string; detail: Record<string, unknown> }>): Promise<Map<string, string | null>> {
  const signed = new Set(rows.filter((row) => row.action === "payee_link_created").map((row) => row.detail.linkId));
  const missing = [...new Set(rows.map(viaLink).filter((id): id is string => id !== null && !signed.has(id)))];
  if (missing.length === 0) return new Map();
  const links = unwrap(await platformDb().from("payee_links").select("id, created_by").eq("org_id", orgId).in("id", missing)) as Array<{
    id: string;
    created_by: string | null;
  }>;
  const found = new Map(links.map((link) => [link.id, link.created_by]));
  return new Map(missing.map((id) => [id, found.get(id) ?? null]));
}
