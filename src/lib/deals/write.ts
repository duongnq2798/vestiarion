import type { CycleLogLine } from "../agent/orchestrator";
import { createCounterparty } from "../counterparties/create";
import { currentOrgId } from "../context";
import { db, unwrap, type OrgDb } from "../dal";
import { FxRateError } from "../fx/usd-rates";
import { counterpartyInputSchema, invoiceInputSchema } from "../intake-validation";
import { createInvoice } from "../invoices/create";
import { assertLedgerCanSign, type LedgerEntryInput } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { shadowBill, ShadowBillError, type OriginalBill } from "../shadow-bills";
import type { ChangeDraft, DealDraft } from "./input";
import { dueForRelease, releaseRefusal, type DealLine, type ReleaseRefusal } from "./lines";
import { formatMinor, minorToDecimal, paidOnArc } from "./money";
import { dealsNotReady, readDeal, type DealRecord } from "./read";
import { planCancel, planRevision, type RevisionProblemCode } from "./revision";

/**
 * Deals, written (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D7-D13): confirming a deal, changing,
 * cancelling and reopening it, releasing a line as a receivable, and the switch that lets the agent's cycle release each
 * line on its day. Every export runs inside an organization scope; who may do it is the command's check. Each version is
 * a signed entry, and each release is the receivable's own `create_invoice` entry.
 */

export const DEAL_ACTIONS = {
  signed: "deal_signed",
  revised: "deal_revised",
  cancelled: "deal_cancelled",
  autoRelease: "deal_auto_release_changed",
} as const;

export type DealErrorCode =
  | "not_ready"
  | "not_found"
  | "customer_not_found"
  | "external_ref_taken"
  | "changed"
  | "key_reused"
  | "line_not_found"
  | "shadow"
  | ReleaseRefusal
  | RevisionProblemCode;

const MESSAGES: Partial<Record<DealErrorCode, string>> = {
  not_ready: "Deals are not set up on this deployment yet.",
  not_found: "That deal was not found.",
  customer_not_found: "That customer was not found. Choose another, or add a new customer.",
  external_ref_taken: "Another deal of this workspace has that external reference.",
  changed: "This deal changed since you opened it. Reload the page to see it as it is now.",
  key_reused: "This form was sent already, with other details. Reload the page and try again.",
  line_not_found: "That line is not on this deal.",
  ended: "A later version of the deal replaced or cancelled that line.",
  credit: "A credit is owed to the customer: it is never invoiced.",
  released: "That line is a receivable already.",
  deal_cancelled: "This deal was cancelled: nothing more is invoiced from it.",
};

export class DealError extends Error {
  constructor(
    readonly code: DealErrorCode,
    message?: string
  ) {
    super(message ?? MESSAGES[code] ?? "That did not work. Try again in a moment.");
    this.name = "DealError";
  }
}

/** A version older than this whose entry is missing gets one when the same confirm comes again (D11). */
const HEAL_AFTER_MS = 60_000;

type RpcError = { code?: string; message?: string; details?: string } | null;

const money = (minor: number, record: Pick<DealRecord, "digits" | "facts">) => `${formatMinor(minor, record.digits)} ${record.facts.currency}`;
const decimal = (minor: number, record: Pick<DealRecord, "digits">) => minorToDecimal(minor, record.digits);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function lineDetail(line: DealLine, record: DealRecord) {
  return {
    lineId: line.id,
    position: line.position,
    kind: line.kind,
    label: line.label,
    invoiceOn: line.invoiceOn,
    dueOn: line.dueOn,
    amount: decimal(line.amountMinor, record),
    amountMinor: line.amountMinor,
    roundingMinor: line.roundingMinor,
    replaces: line.replaces,
  };
}

/**
 * Where a deal or its version came from, when a CRM brought it (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md
 * H11, H12, H19): its entries say `via` and the CRM's ids, as a bill from an accounting tool says its tool's.
 */
export interface DealSource {
  provider: "hubspot";
  ids: { hubId: string; dealId: string; companyId: string | null };
}

const sourceDetail = (source: DealSource | undefined) => (source ? { via: source.provider, [source.provider]: source.ids } : {});

/** The signed entry of a version, built from the deal as it is stored, so a missing one can be written later the same. */
export function versionEntry(record: DealRecord, version: number, by: string | null, source?: DealSource): LedgerEntryInput {
  const row = record.versions.find((candidate) => candidate.version === version);
  if (!row) throw new Error(`deal ${record.facts.id} has no version ${version}`);
  const previous = record.versions.find((candidate) => candidate.version === version - 1);
  const added = record.facts.lines.filter((line) => line.addedIn === version);
  const ended = record.facts.lines.filter((line) => line.endedIn === version);
  const base = {
    by,
    dealId: record.facts.id,
    version,
    counterpartyId: record.customer.id,
    counterpartyName: record.customer.name,
    title: record.title,
    currency: record.facts.currency,
    digits: record.digits,
  };
  if (row.kind === "signed") {
    return {
      actor: "human",
      domain: "ar",
      action: DEAL_ACTIONS.signed,
      summary: `Signed the deal ${record.title} with ${record.customer.name}: ${money(row.totalMinor, record)} in ${plural(added.length, "line", "lines")}`,
      detail: {
        ...base,
        total: decimal(row.totalMinor, record),
        totalMinor: row.totalMinor,
        startsOn: record.facts.startsOn,
        termsDays: record.facts.termsDays,
        externalRef: record.externalRef,
        template: record.template,
        autoRelease: record.facts.autoRelease,
        lines: added.map((line) => lineDetail(line, record)),
        ...sourceDetail(source),
      },
    };
  }
  const fromMinor = previous?.totalMinor ?? 0;
  const common = {
    ...base,
    kind: row.kind,
    fromTotal: decimal(fromMinor, record),
    toTotal: decimal(row.totalMinor, record),
    difference: decimal(row.totalMinor - fromMinor, record),
    fromTotalMinor: fromMinor,
    toTotalMinor: row.totalMinor,
    reason: row.reason,
    ended: ended.map((line) => ({ lineId: line.id, status: line.status })),
    added: added.map((line) => lineDetail(line, record)),
    changes: row.changes,
    ...sourceDetail(source),
  };
  if (row.kind === "cancelled") {
    return {
      actor: "human",
      domain: "ar",
      action: DEAL_ACTIONS.cancelled,
      summary: `Cancelled the deal ${record.title} with ${record.customer.name} (version ${version}): ${plural(ended.length, "line", "lines")} not invoiced stopped`,
      detail: common,
    };
  }
  return {
    actor: "human",
    domain: "ar",
    action: DEAL_ACTIONS.revised,
    summary:
      row.kind === "reopened"
        ? `Reopened the deal ${record.title} with ${record.customer.name} (version ${version}): ${money(row.totalMinor, record)}`
        : `Changed the deal ${record.title} with ${record.customer.name} (version ${version}): ${money(fromMinor, record)} to ${money(row.totalMinor, record)}`,
    detail: common,
  };
}

const lineKey = (line: { kind: string; label: string; invoiceOn: string; amountMinor: number }) => `${line.kind}|${line.label.trim()}|${line.invoiceOn}|${line.amountMinor}`;

/**
 * Whether the deal a key made is the one this draft confirms (D12): a key sent again with other details (a form kept
 * from before, filled in for another deal) is no repeat, and is never answered with the deal the key made.
 */
function sameDeal(record: DealRecord, draft: DealDraft, customerId: string): boolean {
  const signed = record.versions.find((row) => row.version === 1);
  const lines = record.facts.lines.filter((line) => line.addedIn === 1).sort((a, b) => a.position - b.position);
  return (
    record.customer.id === customerId &&
    record.title === draft.title.trim() &&
    record.facts.currency === draft.currency &&
    record.digits === draft.digits &&
    signed?.totalMinor === draft.totalMinor &&
    record.facts.startsOn === draft.startsOn &&
    record.facts.termsDays === draft.termsDays &&
    record.externalRef === (draft.externalRef?.trim() || null) &&
    record.template === draft.template &&
    lines.length === draft.lines.length &&
    draft.lines.every((line, index) => lines[index].position === line.position && lines[index].dueOn === line.dueOn && lineKey(lines[index]) === lineKey(line))
  );
}

/**
 * Whether the version a key made is the change this one asks for (D12): the same kind from the same version, the same
 * total, and the same lines added (each new line, and each planned line changed). Lines never change, so the lines the
 * proposal names are still there to compare with.
 */
function sameChange(record: DealRecord, version: number, change: ChangeDraft): boolean {
  const row = record.versions.find((candidate) => candidate.version === version);
  if (!row || row.kind !== change.kind || version !== change.baseVersion + 1) return false;
  if (change.kind === "cancelled") return true;
  if (row.totalMinor !== change.totalMinor) return false;
  const byId = new Map(record.facts.lines.map((line) => [line.id, line]));
  const asked = change.lines
    .filter((proposed) => {
      const was = proposed.id === undefined ? undefined : byId.get(proposed.id);
      return !was || lineKey(was) !== lineKey(proposed);
    })
    .map(lineKey)
    .sort();
  const added = record.facts.lines
    .filter((line) => line.addedIn === version)
    .map(lineKey)
    .sort();
  return asked.length === added.length && asked.every((key, index) => key === added[index]);
}

/** Reads a deal that must exist now: one just written. */
async function stored(dealId: string): Promise<DealRecord> {
  const read = await readDeal(dealId);
  if (!read.available) throw new DealError("not_ready");
  if (!read.deal) throw new DealError("not_found");
  return read.deal;
}

/**
 * The entry of a version written by a request that died before signing it: written by the same confirm or change when it
 * comes again, once the version is old enough that the first request cannot still be writing it.
 */
async function healEntry(record: DealRecord, version: number, by: string | null, source?: DealSource): Promise<void> {
  const row = record.versions.find((candidate) => candidate.version === version);
  if (!row || Date.now() - Date.parse(row.createdAt) < HEAL_AFTER_MS) return;
  const found = await db()
    .from("ledger_entries")
    .select("seq")
    .in("action", [DEAL_ACTIONS.signed, DEAL_ACTIONS.revised, DEAL_ACTIONS.cancelled])
    .eq("detail->>dealId", record.facts.id)
    .eq("detail->>version", String(version))
    .limit(1);
  if (found.error || (found.data ?? []).length > 0) return;
  await appendLedgerEntryBestEffort(currentOrgId(), versionEntry(record, version, by, source));
}

/** Before anything is written: 0104 must have run here (D15). */
async function ensureReady(): Promise<void> {
  const probe = await db().from("deals").select("id").limit(1);
  if (dealsNotReady(probe.error)) throw new DealError("not_ready");
  if (probe.error) throw new Error(probe.error.message);
}

/** The customer chosen, or the one typed: a client of the same name is used again, so a repeated confirm adds no second one (D12). */
async function resolveCustomer(actorId: string, customer: DealDraft["customer"], source?: DealSource): Promise<{ id: string; name: string }> {
  if ("id" in customer) {
    const found = await db().from("counterparties").select("id, name").eq("id", customer.id).maybeSingle<{ id: string; name: string }>();
    if (found.error) throw new Error(found.error.message);
    if (!found.data) throw new DealError("customer_not_found");
    return found.data;
  }
  const clients = unwrap(await db().from("counterparties").select("id, name").eq("role", "client")) as Array<{ id: string; name: string }>;
  const same = clients.find((client) => client.name.trim().toLowerCase() === customer.name.toLowerCase());
  if (same) return same;
  const created = await createCounterparty({
    actorId,
    counterparty: counterpartyInputSchema.parse({ name: customer.name, noticeEmail: "", role: "client", address: "", jurisdiction: "", paymentLimit: "" }),
    // A customer added with a deal a CRM brought in says so, with the CRM's company (HubSpot connector H11).
    ...(source ? { external: { provider: source.provider, ids: { hubId: source.ids.hubId, companyId: source.ids.companyId } } } : {}),
  });
  return { id: created.id, name: created.name };
}

/** Confirms a deal: version 1 and its planned lines, once per key (D1, D12). */
export async function confirmDeal(input: {
  actorId: string;
  draft: DealDraft;
  source?: DealSource;
}): Promise<{ dealId: string; created: boolean; title: string; customerName: string; customerId: string }> {
  const { actorId, draft } = input;
  await ensureReady();
  // An unreadable signing key refuses the deal before anything is written, rather than leave a version unsigned.
  assertLedgerCanSign();
  const customer = await resolveCustomer(actorId, draft.customer, input.source);
  const result = await db().rpc("create_deal", {
    p_deal: {
      counterpartyId: customer.id,
      title: draft.title,
      currency: draft.currency,
      minorDigits: draft.digits,
      totalMinor: draft.totalMinor,
      startsOn: draft.startsOn,
      termsDays: draft.termsDays,
      externalRef: draft.externalRef,
      template: draft.template,
      autoRelease: draft.autoRelease,
      idempotencyKey: draft.idempotencyKey,
      createdBy: actorId,
      changes: [],
    },
    p_lines: draft.lines.map(({ position, label, invoiceOn, dueOn, amountMinor, roundingMinor }) => ({ position, label, invoiceOn, dueOn, amountMinor, roundingMinor })),
  });
  if (result.error) throw writeError(result.error);
  const { id, created } = result.data as { id: string; created: boolean };
  const record = await stored(id);
  if (!created && !sameDeal(record, draft, customer.id)) throw new DealError("key_reused");
  if (created) await appendLedgerEntryBestEffort(currentOrgId(), versionEntry(record, 1, actorId, input.source));
  else await healEntry(record, 1, actorId, input.source);
  return { dealId: id, created, title: record.title, customerName: record.customer.name, customerId: record.customer.id };
}

function writeError(error: NonNullable<RpcError>): Error {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (dealsNotReady(error)) return new DealError("not_ready");
  if (/deals_external_ref_key/.test(text)) return new DealError("external_ref_taken");
  if (/deals_counterparty_fkey/.test(text)) return new DealError("customer_not_found");
  if (/deal_not_found/.test(text)) return new DealError("not_found");
  if (/deal_changed|deal_line_not_planned|deal_status/.test(text)) return new DealError("changed");
  return new Error(error.message ?? "the deal was not written");
}

/** Changes, cancels or reopens a deal: its next version, planned again from the deal as it is now (D7-D9). */
export async function changeDeal(input: {
  actorId: string;
  change: ChangeDraft;
  source?: DealSource;
}): Promise<{ version: number; created: boolean; title: string; kind: ChangeDraft["kind"] }> {
  const { actorId, change } = input;
  const read = await readDeal(change.dealId);
  if (!read.available) throw new DealError("not_ready");
  if (!read.deal) throw new DealError("not_found");
  // The same change again answers the version it made.
  const repeated = unwrap(
    await db().from("deal_versions").select("version").eq("deal_id", change.dealId).eq("idempotency_key", change.idempotencyKey).limit(1)
  ) as Array<{ version: number }>;
  if (repeated[0]) {
    if (!sameChange(read.deal, repeated[0].version, change)) throw new DealError("key_reused");
    await healEntry(read.deal, repeated[0].version, actorId, input.source);
    return { version: repeated[0].version, created: false, title: read.deal.title, kind: change.kind };
  }
  if (read.deal.facts.version !== change.baseVersion) throw new DealError("changed");
  const plan =
    change.kind === "cancelled"
      ? planCancel(read.deal.facts)
      : planRevision(read.deal.facts, { kind: change.kind, totalMinor: change.totalMinor ?? 0, lines: change.lines });
  if (!plan.ok) throw new DealError(plan.code, plan.message);
  assertLedgerCanSign();
  const result = await db().rpc("revise_deal", {
    p_deal_id: change.dealId,
    p_base_version: change.baseVersion,
    p_revision: {
      kind: plan.revision.kind,
      totalMinor: plan.revision.toTotalMinor,
      reason: change.reason,
      changes: plan.revision.changes,
      idempotencyKey: change.idempotencyKey,
      createdBy: actorId,
      end: plan.revision.end,
      add: plan.revision.add,
    },
  });
  if (result.error) throw writeError(result.error);
  const { version, created } = result.data as { version: number; created: boolean };
  const record = await stored(change.dealId);
  if (!created && !sameChange(record, version, change)) throw new DealError("key_reused");
  if (created) await appendLedgerEntryBestEffort(currentOrgId(), versionEntry(record, version, actorId, input.source));
  else await healEntry(record, version, actorId, input.source);
  return { version, created, title: record.title, kind: plan.revision.kind };
}

/** The receivable a line became, if one was made. */
async function receivableOf(lineId: string): Promise<string | null> {
  const found = unwrap(await db().from("invoices").select("id").eq("deal_line_id", lineId).limit(1)) as Array<{ id: string }>;
  return found[0]?.id ?? null;
}

/**
 * Releases a line as a receivable (D10): claims it (planned to released, compare-and-set), then adds the receivable
 * through `createInvoice`, the one way an invoice is added, naming the deal and the line. One receivable per line: a
 * second release finds the first. If adding it fails, the claim is undone; a line left released with no receivable is
 * released again by the next press or cycle. A line in another currency is taken at its USDC amount at the day's rate,
 * in shadow mode only, as the invoice form takes a bill in the business's own currency.
 */
export async function releaseDealLine(input: { actorId: string | null; dealId: string; lineId: string; via: "person" | "schedule" }): Promise<{
  invoiceId: string;
  made: boolean;
  title: string;
  line: string;
  customerName: string;
  amount: string;
}> {
  const { actorId, dealId, lineId, via } = input;
  const read = await readDeal(dealId);
  if (!read.available) throw new DealError("not_ready");
  const record = read.deal;
  if (!record) throw new DealError("not_found");
  const line = record.facts.lines.find((candidate) => candidate.id === lineId);
  if (!line) throw new DealError("line_not_found");
  const refusal = releaseRefusal(record.facts, line);
  if (refusal) throw new DealError(refusal);
  const answer = (invoiceId: string, made: boolean) => ({ invoiceId, made, title: record.title, line: line.label, customerName: record.customer.name, amount: money(line.amountMinor, record) });

  // A line released before whose receivable was made since this read: done.
  if (line.status === "released") {
    const existing = await receivableOf(line.id);
    if (existing) return answer(existing, false);
  }

  // The amount as the receivable takes it: as it is in USDC or EURC; at the day's rate, in shadow mode, otherwise.
  let amount = minorToDecimal(line.amountMinor, record.digits);
  let currency = record.facts.currency;
  let original: OriginalBill | undefined;
  if (!paidOnArc(currency)) {
    try {
      const bill = await shadowBill({ currency, amount });
      original = bill.original;
      amount = String(bill.usdc);
      currency = "USDC";
    } catch (error) {
      if (error instanceof ShadowBillError || error instanceof FxRateError) throw new DealError("shadow", error.message);
      throw error;
    }
  }
  const invoice = invoiceInputSchema.parse({
    direction: "receivable",
    counterpartyId: record.customer.id,
    amount,
    currency,
    memo: `${record.title}: ${line.label}`.slice(0, 280),
    poReference: "",
    goodsReceived: false,
    dueDate: line.dueOn,
    earlyPayDiscountPct: "",
    discountDeadline: "",
  });

  assertLedgerCanSign();
  let claimed = false;
  if (line.status === "planned") {
    const claim = await db()
      .from("deal_lines")
      .update({ status: "released", released_at: new Date().toISOString(), released_by: actorId, released_via: via })
      .eq("id", line.id)
      .eq("deal_id", dealId)
      .eq("status", "planned")
      .select("id");
    if (claim.error) throw new Error(claim.error.message);
    if ((claim.data ?? []).length === 0) {
      // Someone released it a moment before, or a version ended it.
      const existing = await receivableOf(line.id);
      if (existing) return answer(existing, false);
      throw new DealError("changed");
    }
    claimed = true;
  }

  try {
    const created = await createInvoice({
      actorId,
      invoice,
      document: null,
      ...(original ? { original } : {}),
      deal: { dealId, lineId: line.id, version: record.facts.version, title: record.title, line: line.label, releasedBy: via },
    });
    if (!created) throw new DealError("customer_not_found");
    return answer(created.id, true);
  } catch (error) {
    // One receivable per line: another release made it first.
    if (error instanceof Error && /invoices_deal_line_key/.test(error.message)) {
      const existing = await receivableOf(line.id);
      if (existing) return answer(existing, false);
    }
    if (claimed) {
      const undo = await db()
        .from("deal_lines")
        .update({ status: "planned", released_at: null, released_by: null, released_via: null })
        .eq("id", line.id)
        .eq("status", "released");
      if (undo.error) console.error("deal line release not undone", currentOrgId(), line.id, undo.error.message);
    }
    throw error;
  }
}

/** Turns on or off the agent's release of each line on its invoice day (D10), signed with who set it. */
export async function switchDealAutoRelease(input: { actorId: string; dealId: string; on: boolean }): Promise<{ title: string; changed: boolean }> {
  const { actorId, dealId, on } = input;
  const read = await readDeal(dealId);
  if (!read.available) throw new DealError("not_ready");
  if (!read.deal) throw new DealError("not_found");
  if (on && read.deal.facts.status !== "active") throw new DealError("deal_cancelled");
  assertLedgerCanSign();
  const update = await db()
    .from("deals")
    .update({ auto_release: on, auto_release_by: actorId, auto_release_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", dealId)
    .eq("auto_release", !on)
    .select("id");
  if (update.error) throw new Error(update.error.message);
  const changed = (update.data ?? []).length > 0;
  if (changed) {
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "ar",
      action: DEAL_ACTIONS.autoRelease,
      summary: on
        ? `Turned on releasing each line of the deal ${read.deal.title} on its invoice day`
        : `Turned off releasing the lines of the deal ${read.deal.title} on their invoice days`,
      detail: { by: actorId, dealId, title: read.deal.title, on },
    });
  }
  return { title: read.deal.title, changed };
}

/**
 * The cycle's part (D10): every line whose invoice day has come, of every active deal whose switch is on, released as
 * the agent. A line that cannot be released is said in the cycle's log and tried again at the next cycle. Before 0104
 * runs, nothing.
 */
export async function releaseDueDealLines(orgDb: OrgDb, now: Date = new Date()): Promise<CycleLogLine[]> {
  const due = await orgDb.from("deals").select("id").eq("auto_release", true).eq("status", "active").order("created_at", { ascending: true });
  if (due.error) {
    if (dealsNotReady(due.error)) return [];
    throw new Error(due.error.message);
  }
  const today = now.toISOString().slice(0, 10);
  const log: CycleLogLine[] = [];
  for (const { id } of (due.data ?? []) as Array<{ id: string }>) {
    const read = await readDeal(id, orgDb);
    if (!read.available || !read.deal) continue;
    const record = read.deal;
    for (const line of dueForRelease(record.facts, today)) {
      try {
        const released = await releaseDealLine({ actorId: null, dealId: id, lineId: line.id, via: "schedule" });
        if (released.made) log.push({ domain: "ar", message: `${record.customer.name}: released ${line.label} of the deal ${record.title} as a receivable (${released.amount})` });
      } catch (error) {
        console.error("deal line not released", currentOrgId(), line.id, error instanceof Error ? error.message : error);
        log.push({
          domain: "ar",
          message: `${record.customer.name}: ${line.label} of the deal ${record.title} was not released${error instanceof DealError ? `: ${error.message}` : ""}. The next cycle tries again.`,
        });
      }
    }
  }
  return log;
}
