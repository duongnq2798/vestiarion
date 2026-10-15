import { platformDb, unwrap, type OrgDb } from "./dal";
import { newPayeeCheck, type NewPayeeCheck } from "./new-payee";

/**
 * What the new payee check reads (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N1, N2), once per stage
 * or approval: the addresses each payee asked about has received a confirmed payment at, and each counterparty's ledger
 * entries that set, confirmed or asked for its address, newest first. `newPayeeCheck` (./new-payee) decides from them.
 *
 * A first payment is keyed on the payee and the address together (independent review, 2026-10-15): a confirmed payment
 * counts for the payee its invoice or milestone was for, so an address the workspace paid for someone else is still a
 * first payment for this payee.
 *
 * Who asked the payee for an address they sent is read from the workspace's own signed entries, in the same read as the
 * address's: `payee_link_created` names who created a payee link, and `github_bounty_attached` the member a pull
 * request's bounty acts as. Only when a link's entry is missing is the link's own `payee_links` row read (migration 0039,
 * `created_by`), and set beside the entry as `linkCreatedBy`; the ledger's detail is left as written.
 */
export interface NewPayeeFacts {
  /** For each counterparty asked about, every address it has received a confirmed payment at, lowercase. */
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

  const rows = unwrap(
    await db
      .from("ledger_entries")
      .select("action, detail")
      .in("domain", ADDRESS_DOMAINS)
      .in("action", ADDRESS_ACTIONS)
      .in("detail->>counterpartyId", ids)
      .order("seq", { ascending: false })
  ) as Array<{ action: string; detail: Record<string, unknown> }>;
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

/**
 * Each confirmed payment to these counterparties, as `[counterpartyId, address]`, the address lowercase. A payment is
 * read as its invoice's or milestone's payee's. Which payee a payment was for is asked only when one was confirmed.
 */
async function confirmedPayments(db: OrgDb, ids: string[]): Promise<Array<[string, string]>> {
  const paid = unwrap(await db.from("payment_intents").select("source_type, source_id, destination").eq("status", "confirmed")) as Array<{
    source_type: string;
    source_id: string;
    destination: string | null;
  }>;
  const withAddress = paid.filter((row) => typeof row.destination === "string" && row.destination.length > 0);
  if (withAddress.length === 0) return [];
  const payeeOf = new Map<string, string>();
  if (withAddress.some((row) => row.source_type === "invoice")) {
    const invoices = unwrap(await db.from("invoices").select("id, counterparty_id").in("counterparty_id", ids)) as Array<{ id: string; counterparty_id: string }>;
    for (const invoice of invoices) payeeOf.set(`invoice:${invoice.id}`, invoice.counterparty_id);
  }
  if (withAddress.some((row) => row.source_type === "milestone")) {
    const milestones = unwrap(await db.from("milestones").select("id, contractor_id").in("contractor_id", ids)) as Array<{ id: string; contractor_id: string }>;
    for (const milestone of milestones) payeeOf.set(`milestone:${milestone.id}`, milestone.contractor_id);
  }
  return withAddress.flatMap((row): Array<[string, string]> => {
    const payee = payeeOf.get(`${row.source_type}:${row.source_id}`);
    return payee ? [[payee, (row.destination as string).toLowerCase()]] : [];
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
