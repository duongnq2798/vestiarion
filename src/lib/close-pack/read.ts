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
import { CLOSE_PACK_MAX_PAYMENTS, type ClosePack, type ClosePackIntentRow, type ClosePackInvoiceRow, type ClosePackLedgerRow, type ClosePackMilestoneRow } from "./types";

/**
 * Reads one month's close pack for the workspace in scope (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md,
 * "Data it reads and writes"): the month's payments, their bills, payees and every entry about them, a hundred ids per
 * filter and a page of 1000 rows at a time; each settled payment's screening at the time of its decision, ten reads at
 * once; the month's escrow moves, the payee lock's changes up to the month's end, the first sweep that checked payout
 * addresses, the ledger's head and the members. Then it builds twice, as `readEvidence` does: once to find the entries the
 * pack cites, then with each of those checked against the workspace's keys, retired ones included.
 *
 * Inside the workspace's scope only (`withOrg` or `inOrg`), through `db()`. It reads no chain, calls no model, and writes
 * nothing: no row, no file, no cache.
 */

const PAGE = 1000;
/** Ids per `in` filter, to keep each request's address short, as the payee lock pack's reader does. */
const ID_CHUNK = 100;
/** Screening reads in flight at once. */
const SCREENING_AT_ONCE = 10;

const INTENT_COLUMNS =
  "id, source_type, source_id, status, provider, provider_mode, provider_tx_id, provider_state, failure_reason, last_error, amount, token, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, network, fee_usd, fee_source, transfer_attempt, previous_attempts, batch_key, created_at, updated_at, submitted_at, executed_at, confirmed_at";
const INVOICE_COLUMNS = "id, direction, counterparty_id, amount, currency, paid_amount, memo, po_reference, due_date, status, tx_ref, settled_at";
const MILESTONE_COLUMNS =
  "id, contractor_id, title, amount, status, verified, verification_method, verification_status, verification_source, verification_checked_at, verified_at, verification_detail, tx_ref, settled_at, escrow_state, escrow_payee, escrow_amount, escrow_release_tx_hash";
/** The payee's entries the approval chain reads: who gave and confirmed its address, and the link it came through (CP7). */
const ADDRESS_ACTIONS = ["create_counterparty", "counterparty_address_changed", "counterparty_address_confirmed", "payee_link_created"];
const ESCROW_ACTIONS = ["escrow_funded", "escrow_refunded"];

type Read = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

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
 * Each settled payment's screening (CP8): its payee's newest complete check at or before its anchor, one read per
 * distinct payee and time, ten at once. A read that fails is "unread" for its payments, and the rest show.
 */
async function screeningOf(orgDb: OrgDb, anchors: ReadonlyMap<string, { counterpartyId: string; at: string }>): Promise<Map<string, EvidenceScreening | null | "unread">> {
  const keyOf = (anchor: { counterpartyId: string; at: string }) => `${anchor.counterpartyId}|${anchor.at}`;
  const distinct = new Map<string, { counterpartyId: string; at: string }>();
  for (const anchor of anchors.values()) distinct.set(keyOf(anchor), anchor);
  const found = new Map<string, EvidenceScreening | null | "unread">();
  const reads = [...distinct.entries()];
  for (let start = 0; start < reads.length; start += SCREENING_AT_ONCE) {
    await Promise.all(
      reads.slice(start, start + SCREENING_AT_ONCE).map(async ([key, anchor]) => {
        try {
          const rows = unwrap(
            await orgDb
              .from("compliance_checks")
              .select("risk_level, source, screening_mode, created_at")
              .eq("counterparty_id", anchor.counterpartyId)
              .eq("status", "complete")
              .lte("created_at", anchor.at)
              .order("created_at", { ascending: false })
              .limit(1)
          ) as Array<Record<string, unknown>>;
          const row = rows[0];
          found.set(
            key,
            row ? { risk_level: String(row.risk_level), source: String(row.source), screening_mode: String(row.screening_mode), created_at: String(row.created_at) } : null
          );
        } catch (error) {
          console.error("close pack: a screening record not read", error instanceof Error ? error.message : error);
          found.set(key, "unread");
        }
      })
    );
  }
  return new Map([...anchors.entries()].map(([paymentId, anchor]) => [paymentId, found.get(keyOf(anchor)) ?? null]));
}

export async function readClosePack(input: {
  month: ClosePackMonth;
  /** From the session's membership; when absent, read from `orgs` by the scope's org id (an API key, a job). */
  workspace?: { slug: string; name: string };
  /** "email" for a person's page and files; "id" for the API (CP18). Default "email". */
  people?: "email" | "id";
  now?: Date;
}): Promise<ClosePack> {
  const orgDb = db();
  const now = input.now ?? new Date();
  const from = `${input.month.from}T00:00:00.000Z`;
  const to = `${input.month.to}T00:00:00.000Z`;
  const inMonth = (column: string) => `and(${column}.gte.${from},${column}.lt.${to})`;

  // The month's payments: confirmed, created or sent in it (CP2, CP3), one more than a pack holds, to tell a cut (CP15).
  const [intentsRead, escrow, lockChanges, sweep, head, members, workspace] = await Promise.all([
    allRows<ClosePackIntentRow>(
      (start, end) =>
        orgDb
          .from("payment_intents")
          .select(INTENT_COLUMNS)
          .or(`${inMonth("confirmed_at")},${inMonth("created_at")},${inMonth("submitted_at")}`)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(start, end),
      CLOSE_PACK_MAX_PAYMENTS + 1
    ),
    ledgerRows(orgDb, (query) => query.in("action", ESCROW_ACTIONS).gte("ts", from).lt("ts", to)),
    // The lock in force when a payment was sent (CP8): an owner's changes name no payee, so the workspace's are read, from
    // its first up to the month's end.
    ledgerRows(orgDb, (query) => query.eq("action", "payee_lock_changed").lt("ts", to)),
    orgDb.from("ledger_entries").select("ts").eq("action", "compliance_sweep").not("detail->sanctionedWallets", "is", null).order("seq", { ascending: true }).limit(1),
    orgDb.from("ledger_entries").select("seq, hash").order("seq", { ascending: false }).limit(1),
    membersOf(),
    input.workspace ? Promise.resolve(input.workspace) : workspaceOf(),
  ]);
  const cut = intentsRead.length > CLOSE_PACK_MAX_PAYMENTS;
  const intents = intentsRead.slice(0, CLOSE_PACK_MAX_PAYMENTS);
  const walletListSince = (unwrap(sweep) as Array<{ ts: string }>)[0]?.ts ?? null;
  const headRow = (unwrap(head) as Array<{ seq: number; hash: string }>)[0] ?? null;

  const invoiceIds = unique(intents.filter((intent) => intent.source_type === "invoice").map((intent) => intent.source_id));
  const milestoneIds = unique([
    ...intents.filter((intent) => intent.source_type === "milestone").map((intent) => intent.source_id),
    ...escrow.map((entry) => (typeof entry.detail.milestoneId === "string" ? entry.detail.milestoneId : null)),
  ]);
  const [invoices, milestones, documentPayTo] = await Promise.all([
    byChunks(invoiceIds, async (chunk) => unwrap(await orgDb.from("invoices").select(INVOICE_COLUMNS).in("id", chunk)) as ClosePackInvoiceRow[]),
    byChunks(milestoneIds, async (chunk) => unwrap(await orgDb.from("milestones").select(MILESTONE_COLUMNS).in("id", chunk)) as ClosePackMilestoneRow[]),
    // None before migration 0136: the pay-to check then does not apply (CP19).
    readDocumentPayTo(invoiceIds, orgDb),
  ]);

  const payableIds = invoices.filter((invoice) => invoice.direction === "payable").map((invoice) => invoice.id);
  const payeeIds = unique([...invoices.filter((invoice) => invoice.direction === "payable").map((invoice) => invoice.counterparty_id), ...milestones.map((milestone) => milestone.contractor_id)]);
  const [counterparties, ownInvoices, ownMilestones, verdicts, payees] = await Promise.all([
    byChunks(payeeIds, async (chunk) => unwrap(await orgDb.from("counterparties").select("id, name, address, chain, sample").in("id", chunk)) as Array<{ id: string; name: string; address: string | null; sample: boolean | null }>),
    byChunks(payableIds, (chunk) => ledgerRows(orgDb, (query) => query.in("detail->>invoiceId", chunk))),
    byChunks(milestoneIds, (chunk) => ledgerRows(orgDb, (query) => query.in("detail->>milestoneId", chunk))),
    // A verdict names the payable as its subject, never by invoiceId (shadow mode S3), so it is read on its own.
    byChunks(payableIds, (chunk) => ledgerRows(orgDb, (query) => query.eq("action", "decision_verdict").in("detail->>subjectId", chunk))),
    byChunks(payeeIds, (chunk) => ledgerRows(orgDb, (query) => query.in("detail->>counterpartyId", chunk).in("action", ADDRESS_ACTIONS))),
  ]);

  const bySeq = new Map<number, ClosePackLedgerRow>();
  for (const entry of [...ownInvoices, ...ownMilestones, ...verdicts, ...payees, ...escrow, ...lockChanges]) bySeq.set(entry.seq, entry);
  const keyring = ledgerVerificationKeyring();
  const base: Omit<ClosePackInput, "screening" | "checks"> = {
    workspace,
    network: workspaceNetwork().id,
    month: input.month,
    now,
    intents,
    invoices,
    milestones,
    counterparties: new Map(counterparties.map((row) => [row.id, { name: row.name, address: row.address, sample: row.sample === true }])),
    documentPayTo,
    entries: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    walletListSince,
    members,
    people: input.people ?? "email",
    keys: exportKeys(keyring),
    ledgerHead: headRow ? { seq: headRow.seq, hash: headRow.hash } : null,
    cut,
  };
  const screening = await screeningOf(orgDb, screeningAnchors(base));

  // Built once to find the entries it cites, then again with each of those checked alone (CP10).
  const first = buildClosePack({ ...base, screening });
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
  return buildClosePack({ ...base, screening, checks: new Map(checked) });
}
