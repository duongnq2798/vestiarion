import { currentOrgId } from "../context";
import { db, platformDb, unwrap, type OrgDb } from "../dal";
import type { EvidenceScreening } from "../evidence-chain";
import { readDocumentPayTo } from "../invoice-pay-to";
import { ledgerPublicKeyPems, ledgerVerificationKeyring } from "../ledger";
import { exportKeys } from "../ledger-export";
import { listMembers } from "../platform/members";
import { verifyEntry, type EntryCheck } from "../receipts/verify";
import { workspaceNetwork } from "../workspace-network";
import { buildClosePack, screeningAnchors, type ClosePackInput } from "./build";
import type { ClosePackMonth } from "./month";
import { logClosePackTiming, msSince } from "./timing";
import { CLOSE_PACK_MAX_PAYMENTS, type ClosePack, type ClosePackIntentRow, type ClosePackInvoiceRow, type ClosePackLedgerRow, type ClosePackMilestoneRow } from "./types";

/**
 * Reads one month's close pack for the workspace in scope (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md,
 * "Data it reads and writes"): the month's payments, their bills, payees and every entry about them, a hundred ids per
 * filter and a page of 1000 rows at a time; each settled payment's screening at the time of its decision; the month's
 * escrow moves, the payee lock's changes up to the month's end, the first sweep that checked payout addresses, the
 * ledger's head and the members. Then it builds twice, as `readEvidence` does: once to find the entries the pack cites,
 * then with each of those checked against the workspace's keys, retired ones included.
 *
 * Each read starts the moment the reads it needs have answered, not when a whole wave has
 * (docs/superpowers/specs/2026-10-26-close-pack-page-speed-design.md CS2, CS3): three rounds of reads, the screening
 * among the last, and the pack built from exactly what the reader before built it from (CS1).
 *
 * Inside the workspace's scope only (`withOrg` or `inOrg`), through `db()`. It reads no chain, calls no model, and writes
 * nothing: no row, no file, no cache. It logs one timing line (CS7).
 */

const PAGE = 1000;
/** Ids per `in` filter, to keep each request's address short, as the payee lock pack's reader does. */
const ID_CHUNK = 100;
/** One payee's screening reads in flight at once, for the payees whose checks could not be read together (CS3). */
const SCREENING_AT_ONCE = 10;

const INTENT_COLUMNS =
  "id, source_type, source_id, status, provider, provider_mode, provider_tx_id, provider_state, failure_reason, last_error, amount, token, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, network, fee_usd, fee_source, transfer_attempt, previous_attempts, batch_key, created_at, updated_at, submitted_at, executed_at, confirmed_at";
const INVOICE_COLUMNS = "id, direction, counterparty_id, amount, currency, paid_amount, memo, po_reference, due_date, status, tx_ref, settled_at";
const MILESTONE_COLUMNS =
  "id, contractor_id, title, amount, status, verified, verification_method, verification_status, verification_source, verification_checked_at, verified_at, verification_detail, tx_ref, settled_at, escrow_state, escrow_payee, escrow_amount, escrow_release_tx_hash";
const SCREENING_COLUMNS = "risk_level, source, screening_mode, created_at";
/** The payee's entries the approval chain reads: who gave and confirmed its address, and the link it came through (CP7). */
const ADDRESS_ACTIONS = ["create_counterparty", "counterparty_address_changed", "counterparty_address_confirmed", "payee_link_created"];
const ESCROW_ACTIONS = ["escrow_funded", "escrow_refunded"];

type Read = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
type Anchor = { counterpartyId: string; at: string };
type Screening = EvidenceScreening | null | "unread";

const chunks = <T>(values: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(values.length / ID_CHUNK) }, (_, index) => values.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK));
const unique = (values: Iterable<string | null | undefined>) => [...new Set([...values].filter((value): value is string => typeof value === "string" && value.length > 0))];

/** Every row a query returns, a page at a time, up to `most` when one is given. */
async function allRows<T>(build: (start: number, end: number) => Read, most = Number.POSITIVE_INFINITY): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < most; start += PAGE) {
    const end = Math.min(start + PAGE, most) - 1;
    const page = unwrap((await build(start, end)) as { data: T[] | null; error: { message: string } | null });
    rows.push(...page);
    if (page.length < end - start + 1) break;
  }
  return rows;
}

/** One read per chunk of ids, each read whole. */
async function byChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  return (await Promise.all(chunks(ids).map(read))).flat();
}

function ledgerRows(orgDb: OrgDb, filter: (query: ReturnType<ReturnType<OrgDb["from"]>["select"]>) => ReturnType<ReturnType<OrgDb["from"]>["select"]>) {
  return allRows<ClosePackLedgerRow>((start, end) => filter(orgDb.from("ledger_entries").select("*")).order("seq", { ascending: true }).range(start, end));
}

/** Entries, each once by seq, oldest first: what the pack is built from. */
function bySeq(...groups: ReadonlyArray<readonly ClosePackLedgerRow[]>): ClosePackLedgerRow[] {
  const entries = new Map<number, ClosePackLedgerRow>();
  for (const group of groups) for (const entry of group) entries.set(entry.seq, entry);
  return [...entries.values()].sort((a, b) => a.seq - b.seq);
}

/** Members by user id; null when they could not be read, so the pack names people by id and says so (CP7). */
async function membersOf(): Promise<ClosePackInput["members"]> {
  try {
    return new Map((await listMembers(currentOrgId())).map((member) => [member.userId, { email: member.email, role: member.role }]));
  } catch (error) {
    console.error("close pack: members not read", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The workspace's slug and name, by the scope's org id: for an API key or a job, which hold no membership. */
async function workspaceOf(): Promise<{ slug: string; name: string }> {
  const rows = unwrap(await platformDb().from("orgs").select("slug, name").eq("id", currentOrgId()).limit(1)) as Array<{ slug: string; name: string }>;
  if (!rows[0]) throw new Error("close pack: the workspace in scope was not found");
  return { slug: rows[0].slug, name: rows[0].name };
}

/**
 * A Postgres time in microseconds since 1970, compared as `created_at <= at` compares it; null for one written any other
 * way (more than six places, no zone), which the screening then reads alone rather than guess (CS3).
 */
function microsOf(ts: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(ts);
  if (!match) return null;
  const [, date, time, fraction = "", zone] = match;
  const offset = zone === "Z" ? zone : zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const seconds = Date.parse(`${date}T${time}${offset}`);
  return Number.isNaN(seconds) ? null : seconds * 1000 + Number(fraction.padEnd(6, "0"));
}

const screeningOfRow = (row: Record<string, unknown>): EvidenceScreening => ({
  risk_level: String(row.risk_level),
  source: String(row.source),
  screening_mode: String(row.screening_mode),
  created_at: String(row.created_at),
});

/**
 * One payee's newest complete check at or before one time (CP8), a tie going to the larger id. A read that fails is
 * "unread" for its payments, and the rest show.
 */
async function screeningAlone(orgDb: OrgDb, anchor: Anchor): Promise<Screening> {
  try {
    const rows = unwrap(
      await orgDb
        .from("compliance_checks")
        .select(SCREENING_COLUMNS)
        .eq("counterparty_id", anchor.counterpartyId)
        .eq("status", "complete")
        .lte("created_at", anchor.at)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
    ) as Array<Record<string, unknown>>;
    return rows[0] ? screeningOfRow(rows[0]) : null;
  } catch (error) {
    console.error("close pack: a screening record not read", error instanceof Error ? error.message : error);
    return "unread";
  }
}

/**
 * Up to a hundred payees' checks in one read (CS3): their complete checks up to the latest of the times asked, newest
 * first, a tie by the larger id, a page of 1000; then for each payee and time, the first of its payee's at or before
 * it, which is what the read for that payee and time alone answers. Null when this read cannot say for every one of
 * them, and each is then read alone: the read failed, it filled its page (an older check may lie past it), or a time
 * did not read.
 */
async function screeningTogether(orgDb: OrgDb, anchors: readonly Anchor[]): Promise<Screening[] | null> {
  const times = anchors.map((anchor) => microsOf(anchor.at));
  if (times.some((time) => time === null)) return null;
  const latest = anchors[times.indexOf(Math.max(...(times as number[])))];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = unwrap(
      await orgDb
        .from("compliance_checks")
        .select(`counterparty_id, ${SCREENING_COLUMNS}`)
        .in("counterparty_id", unique(anchors.map((anchor) => anchor.counterpartyId)))
        .eq("status", "complete")
        .lte("created_at", latest.at)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(0, PAGE - 1)
    ) as Array<Record<string, unknown>>;
  } catch (error) {
    console.error("close pack: screening records not read at once", error instanceof Error ? error.message : error);
    return null;
  }
  if (rows.length >= PAGE) return null;
  const made = rows.map((row) => microsOf(String(row.created_at)));
  if (made.some((time) => time === null)) return null;
  return anchors.map((anchor, index) => {
    const found = rows.findIndex((row, at) => row.counterparty_id === anchor.counterpartyId && (made[at] as number) <= (times[index] as number));
    return found === -1 ? null : screeningOfRow(rows[found]);
  });
}

/**
 * Each settled payment's screening (CP8, CS3): its payee's newest complete check at or before its anchor. The distinct
 * payees and times are read a hundred payees at once; those a read could not answer, one at a time, ten in flight.
 */
async function screeningOf(orgDb: OrgDb, anchors: ReadonlyMap<string, Anchor>): Promise<{ screening: Map<string, Screening>; reads: number }> {
  const keyOf = (anchor: Anchor) => `${anchor.counterpartyId}|${anchor.at}`;
  const byPayee = new Map<string, Anchor[]>();
  const seen = new Set<string>();
  for (const anchor of anchors.values()) {
    if (seen.has(keyOf(anchor))) continue;
    seen.add(keyOf(anchor));
    byPayee.set(anchor.counterpartyId, [...(byPayee.get(anchor.counterpartyId) ?? []), anchor]);
  }
  const found = new Map<string, Screening>();
  const alone: Anchor[] = [];
  let reads = 0;
  await Promise.all(
    chunks([...byPayee.keys()]).map(async (payees) => {
      const asked = payees.flatMap((payee) => byPayee.get(payee) ?? []);
      reads += 1;
      const answers = await screeningTogether(orgDb, asked);
      if (answers) asked.forEach((anchor, index) => found.set(keyOf(anchor), answers[index]));
      else alone.push(...asked);
    })
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCREENING_AT_ONCE, alone.length) }, async () => {
      while (next < alone.length) {
        const anchor = alone[next];
        next += 1;
        reads += 1;
        found.set(keyOf(anchor), await screeningAlone(orgDb, anchor));
      }
    })
  );
  return { screening: new Map([...anchors.entries()].map(([paymentId, anchor]) => [paymentId, found.get(keyOf(anchor)) ?? null])), reads };
}

export async function readClosePack(input: {
  month: ClosePackMonth;
  /** From the session's membership; when absent, read from `orgs` by the scope's org id (an API key, a job). */
  workspace?: { slug: string; name: string };
  /** "email" for a person's page and files; "id" for the API (CP18). Default "email". */
  people?: "email" | "id";
  now?: Date;
}): Promise<ClosePack> {
  const started = performance.now();
  const orgDb = db();
  const now = input.now ?? new Date();
  const network = workspaceNetwork().id;
  const from = `${input.month.from}T00:00:00.000Z`;
  const to = `${input.month.to}T00:00:00.000Z`;
  const inMonth = (column: string) => `and(${column}.gte.${from},${column}.lt.${to})`;

  // First, everything that needs only the month (CS2). The month's payments: confirmed, created or sent in it (CP2,
  // CP3), one more than a pack holds, to tell a cut (CP15).
  const paymentsRead = allRows<ClosePackIntentRow>(
    (start, end) =>
      orgDb
        .from("payment_intents")
        .select(INTENT_COLUMNS)
        .or(`${inMonth("confirmed_at")},${inMonth("created_at")},${inMonth("submitted_at")}`)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(start, end),
    CLOSE_PACK_MAX_PAYMENTS + 1
  ).then((read) => {
    const intents = read.slice(0, CLOSE_PACK_MAX_PAYMENTS);
    return { intents, cut: read.length > CLOSE_PACK_MAX_PAYMENTS, invoiceIds: unique(intents.filter((intent) => intent.source_type === "invoice").map((intent) => intent.source_id)) };
  });
  const escrowRead = ledgerRows(orgDb, (query) => query.in("action", ESCROW_ACTIONS).gte("ts", from).lt("ts", to));
  // The lock in force when a payment was sent (CP8): an owner's changes name no payee, so the workspace's are read, from
  // its first up to the month's end.
  const lockChangesRead = ledgerRows(orgDb, (query) => query.eq("action", "payee_lock_changed").lt("ts", to));
  const restRead = Promise.all([
    orgDb.from("ledger_entries").select("ts").eq("action", "compliance_sweep").not("detail->sanctionedWallets", "is", null).order("seq", { ascending: true }).limit(1),
    orgDb.from("ledger_entries").select("seq, hash").order("seq", { ascending: false }).limit(1),
    membersOf(),
    input.workspace ? Promise.resolve(input.workspace) : workspaceOf(),
  ]);

  // The bills, the entries naming them and the verdicts on them, the moment the payments answer. The entries and the
  // verdicts are asked for by every invoice a payment names, so they need not wait for the bills to say which are
  // payable; a customer's invoice's are dropped below, leaving what the reads by the payables' ids answered (CS1, CS2).
  const invoicesRead = paymentsRead.then(({ invoiceIds }) =>
    byChunks(invoiceIds, async (chunk) => unwrap(await orgDb.from("invoices").select(INVOICE_COLUMNS).in("id", chunk)) as ClosePackInvoiceRow[])
  );
  // None before migration 0136: the pay-to check then does not apply (CP19).
  const payToRead = paymentsRead.then(({ invoiceIds }) => readDocumentPayTo(invoiceIds, orgDb));
  const invoiceEntriesRead = paymentsRead.then(({ invoiceIds }) => byChunks(invoiceIds, (chunk) => ledgerRows(orgDb, (query) => query.in("detail->>invoiceId", chunk))));
  // A verdict names the payable as its subject, never by invoiceId (shadow mode S3), so it is read on its own.
  const verdictsRead = paymentsRead.then(({ invoiceIds }) =>
    byChunks(invoiceIds, (chunk) => ledgerRows(orgDb, (query) => query.eq("action", "decision_verdict").in("detail->>subjectId", chunk)))
  );
  const milestoneIdsRead = Promise.all([paymentsRead, escrowRead]).then(([{ intents }, escrow]) =>
    unique([
      ...intents.filter((intent) => intent.source_type === "milestone").map((intent) => intent.source_id),
      ...escrow.map((entry) => (typeof entry.detail.milestoneId === "string" ? entry.detail.milestoneId : null)),
    ])
  );
  const milestonesRead = milestoneIdsRead.then((ids) =>
    byChunks(ids, async (chunk) => unwrap(await orgDb.from("milestones").select(MILESTONE_COLUMNS).in("id", chunk)) as ClosePackMilestoneRow[])
  );
  const ownMilestonesRead = milestoneIdsRead.then((ids) => byChunks(ids, (chunk) => ledgerRows(orgDb, (query) => query.in("detail->>milestoneId", chunk))));

  // Then the payees, once the bills and milestones name them, and what the payables' entries and verdicts are.
  const billsRead = Promise.all([invoicesRead, milestonesRead]).then(([invoices, milestones]) => {
    const payables = invoices.filter((invoice) => invoice.direction === "payable");
    return { payable: new Set(payables.map((invoice) => invoice.id)), payeeIds: unique([...payables.map((invoice) => invoice.counterparty_id), ...milestones.map((milestone) => milestone.contractor_id)]) };
  });
  const counterpartiesRead = billsRead.then(({ payeeIds }) =>
    byChunks(payeeIds, async (chunk) => unwrap(await orgDb.from("counterparties").select("id, name, address, chain, sample").in("id", chunk)) as Array<{ id: string; name: string; address: string | null; sample: boolean | null }>)
  );
  const payeeEntriesRead = billsRead.then(({ payeeIds }) => byChunks(payeeIds, (chunk) => ledgerRows(orgDb, (query) => query.in("detail->>counterpartyId", chunk).in("action", ADDRESS_ACTIONS))));
  const naming = (key: "invoiceId" | "subjectId", payable: ReadonlySet<string>) => (entry: ClosePackLedgerRow) => {
    const id = entry.detail[key];
    return typeof id === "string" && payable.has(id);
  };
  const ownInvoicesRead = Promise.all([billsRead, invoiceEntriesRead]).then(([{ payable }, entries]) => entries.filter(naming("invoiceId", payable)));
  const ownVerdictsRead = Promise.all([billsRead, verdictsRead]).then(([{ payable }, entries]) => entries.filter(naming("subjectId", payable)));

  // Each settled payment's screening, beside the payees: its anchor needs only the bills and the entries naming them,
  // which hold every entry about a bill (CS3).
  const screeningRead = Promise.all([paymentsRead, invoicesRead, milestonesRead, ownInvoicesRead, ownMilestonesRead, escrowRead, lockChangesRead]).then(
    async ([{ intents }, invoices, milestones, ownInvoices, ownMilestones, escrow, lockChanges]) => {
      const anchors = screeningAnchors({ network, month: input.month, now, intents, invoices, milestones, entries: bySeq(ownInvoices, ownMilestones, escrow, lockChanges) });
      const asked = performance.now();
      return { ...(await screeningOf(orgDb, anchors)), ms: msSince(asked) };
    }
  );

  const [payments, escrow, lockChanges, [sweep, head, members, workspace], invoices, milestones, documentPayTo, counterparties, ownInvoices, ownMilestones, verdicts, payees, screened] =
    await Promise.all([
      paymentsRead,
      escrowRead,
      lockChangesRead,
      restRead,
      invoicesRead,
      milestonesRead,
      payToRead,
      counterpartiesRead,
      ownInvoicesRead,
      ownMilestonesRead,
      ownVerdictsRead,
      payeeEntriesRead,
      screeningRead,
    ]);
  const reads = msSince(started);
  const walletListSince = (unwrap(sweep) as Array<{ ts: string }>)[0]?.ts ?? null;
  const headRow = (unwrap(head) as Array<{ seq: number; hash: string }>)[0] ?? null;

  const keyring = ledgerVerificationKeyring();
  const base: Omit<ClosePackInput, "screening" | "checks"> = {
    workspace,
    network,
    month: input.month,
    now,
    intents: payments.intents,
    invoices,
    milestones,
    counterparties: new Map(counterparties.map((row) => [row.id, { name: row.name, address: row.address, sample: row.sample === true }])),
    documentPayTo,
    entries: bySeq(ownInvoices, ownMilestones, verdicts, payees, escrow, lockChanges),
    walletListSince,
    members,
    people: input.people ?? "email",
    keys: exportKeys(keyring),
    ledgerHead: headRow ? { seq: headRow.seq, hash: headRow.hash } : null,
    cut: payments.cut,
  };
  const screening = screened.screening;

  // Built once to find the entries it cites, then again with each of those checked alone (CP10).
  let building = performance.now();
  const first = buildClosePack({ ...base, screening });
  let build = msSince(building);
  const verifying = performance.now();
  const publicKeys = ledgerPublicKeyPems(keyring);
  const checked = await Promise.all(
    first.entries.map(async (entry): Promise<[number, EntryCheck]> => {
      try {
        return [entry.seq, await verifyEntry({ ...entry, signing_key_id: entry.signing_key_id ?? null }, publicKeys)];
      } catch {
        return [entry.seq, { ok: null, reason: "The signature could not be checked here." }];
      }
    })
  );
  const verify = msSince(verifying);
  building = performance.now();
  const pack = buildClosePack({ ...base, screening, checks: new Map(checked) });
  build += msSince(building);
  logClosePackTiming("read", {
    reads,
    screening: screened.ms,
    verify,
    build,
    total: msSince(started),
    payments: payments.intents.length,
    entries: base.entries.length,
    cited: pack.entries.length,
    screeningReads: screened.reads,
  });
  return pack;
}
