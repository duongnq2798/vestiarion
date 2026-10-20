import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * The payee lock (docs/superpowers/specs/2026-10-20-payee-lock-design.md). Off by default; an owner turns it on in
 * Settings. With it on:
 * - confirming a changed payout address needs a record of how it was checked (PL2);
 * - whoever entered or asked for the address may not confirm it, unless no one else can (PL3);
 * - approving a payment no longer confirms its address (PL4);
 * - a changed address waits a cooling-off before it can be paid, confirmed or not (PL5).
 *
 * Lookalike addresses are named on Counterparties whether or not the lock is on (PL6). Every export that touches the
 * database runs inside an organization scope; who may change the setting (`approval.policy`, owners) is the caller's check.
 */

export interface PayeeLock {
  on: boolean;
  /** Hours a changed address waits before it can be paid; 0 is no wait. */
  coolingHours: number;
}

export const PAYEE_LOCK_OFF: PayeeLock = { on: false, coolingHours: 0 };
export const COOLING_HOURS_MAX = 168;
/** The waits Settings offers. */
export const COOLING_HOURS_CHOICES = [0, 4, 24, 48, 72] as const;

/**
 * The columns are 0135's: before it runs, a select names a column the table does not have (42703, Postgres's own), and
 * an upsert one PostgREST's schema cache does not know (PGRST204). Only those codes: any other failure, a permission
 * refused included, throws rather than read as no lock.
 */
export function payeeLockColumnsMissing(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204";
}

/**
 * The workspace's lock, and whether the database has it at all (`ready`, migration 0135). A workspace with no row, or
 * before 0135, reads as off. Any other failure throws: what reads it stops rather than pay past a lock it cannot read.
 */
export async function readPayeeLockStatus(orgDb: OrgDb): Promise<{ lock: PayeeLock; ready: boolean }> {
  const result = await orgDb.from("approval_policies").select("payee_lock, payee_lock_cooling_hours").limit(1);
  if (result.error) {
    if (payeeLockColumnsMissing(result.error)) return { lock: PAYEE_LOCK_OFF, ready: false };
    throw new Error(`approval_policies not read: ${result.error.message}`);
  }
  const row = ((result.data ?? []) as Array<{ payee_lock: boolean | null; payee_lock_cooling_hours: number | string | null }>)[0];
  return { lock: payeeLockFromRow(row), ready: true };
}

/** A lock as its `approval_policies` row holds it; no row, or no columns in it, is off. */
export function payeeLockFromRow(row: { payee_lock?: boolean | null; payee_lock_cooling_hours?: number | string | null } | undefined): PayeeLock {
  if (!row) return PAYEE_LOCK_OFF;
  const hours = Number(row.payee_lock_cooling_hours ?? 0);
  return { on: row.payee_lock === true, coolingHours: Number.isInteger(hours) && hours >= 0 ? Math.min(hours, COOLING_HOURS_MAX) : 0 };
}

/** The workspace's lock (PL1); off before 0135 and for a workspace that never set it. */
export async function readPayeeLock(orgDb: OrgDb): Promise<PayeeLock> {
  return (await readPayeeLockStatus(orgDb)).lock;
}

/**
 * Until when a payment to a counterparty whose address changed at `changedAt` waits (PL5), or null when it does not:
 * the lock is off, it has no cooling-off, or the address was never changed (one typed in when the counterparty was added).
 */
export function coolingOffUntil(changedAt: string | null | undefined, lock: PayeeLock): Date | null {
  if (!lock.on || lock.coolingHours <= 0 || !changedAt) return null;
  const until = Date.parse(changedAt) + lock.coolingHours * 3_600_000;
  return Number.isFinite(until) ? new Date(until) : null;
}

/** The time a payment waits for (PL5) while it is still ahead of `now`; null once it has passed, or when none applies. */
export function inCoolingOff(changedAt: string | null | undefined, lock: PayeeLock, now: number = Date.now()): Date | null {
  const until = coolingOffUntil(changedAt, lock);
  return until && until.getTime() > now ? until : null;
}

/** A UTC time as people read it: "Oct 21, 2026, 14:05 UTC". */
export function coolingOffLabel(until: Date): string {
  const day = until.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = until.toISOString().slice(11, 16);
  return `${day}, ${time} UTC`;
}

/**
 * Why a person may not pay this counterparty now under the payee lock, or null when they may (PL4, PL5): an address
 * waiting for confirmation is confirmed on Counterparties with a record of how it was checked, never by approving a
 * payment; and a changed address waits out its cooling-off. Read before anything is claimed. The lock off, nothing.
 */
export async function payeeLockRefusal(counterpartyId: string, payeeName: string, now: number = Date.now()): Promise<string | null> {
  const lock = await readPayeeLock(db());
  if (!lock.on) return null;
  const found = await db().from("counterparties").select("address_changed_at, address_confirmed_at").eq("id", counterpartyId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const row = found.data as { address_changed_at: string | null; address_confirmed_at: string | null } | null;
  if (!row) return null;
  // As `addressUnconfirmed` (./counterparty-address) reads it: changed, and no confirmation since.
  const changed = row.address_changed_at;
  if (changed && (!row.address_confirmed_at || Date.parse(row.address_confirmed_at) < Date.parse(changed))) {
    return `Confirm ${payeeName}'s address on Counterparties first, and record how you checked it.`;
  }
  const until = inCoolingOff(changed, lock, now);
  if (until) return `${payeeName}'s address changed recently, and the payee lock makes it wait: it can be paid from ${coolingOffLabel(until)}.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The verification record (PL2)

export type VerificationMethod = "call" | "message" | "in_person" | "other";
export const VERIFICATION_METHODS: readonly VerificationMethod[] = ["call", "message", "in_person", "other"];
export const VERIFICATION_LABELS: Record<VerificationMethod, string> = {
  call: "Called them on a number we had before",
  message: "Messaged them on a channel we used before",
  in_person: "In person",
  other: "Another way",
};
export const VERIFICATION_CONTACT_MAX = 200;
export const VERIFICATION_NOTE_MAX = 300;

export interface Verification {
  method: VerificationMethod;
  /** The number or channel used, for a call or a message. */
  contact: string | null;
  /** Whether that contact was on file before the new address arrived, as the person confirming says. */
  contactOnFileBefore: boolean;
  note: string | null;
}

export type VerificationProblem = "method" | "contact" | "contact_not_on_file" | "note" | "text";
export const VERIFICATION_MESSAGES: Record<VerificationProblem, string> = {
  method: "Choose how you checked the address.",
  contact: "Say which number or channel you used.",
  contact_not_on_file: "Check it with a contact you had before the new address arrived, not one that came with it.",
  note: "Say how you checked it.",
  text: "Use plain text, without links, and keep it short.",
};

// Control characters, and format characters such as U+202E, which reverses how the text after it reads.
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const CONTROL_BUT_LINE_BREAK = /(?!\n)[\p{Cc}\p{Cf}]/u;
const LINK = /:\/\/|www\./i;

const isMethod = (value: string): value is VerificationMethod => (VERIFICATION_METHODS as readonly string[]).includes(value);

/**
 * The form's record of how an address was checked (PL2). With the lock off every field is optional and an empty form
 * records nothing (`null`); anything filled in needs its method. With the lock on, the method is required; a call or a
 * message names its contact and says it was on file before the new address arrived; "Another way" says how in its note.
 */
export function parseVerification(
  raw: { method?: string | null; contact?: string | null; contactOnFileBefore?: boolean | string | null; note?: string | null },
  lockOn: boolean
): { ok: true; verification: Verification | null } | { ok: false; problem: VerificationProblem; message: string } {
  const refuse = (problem: VerificationProblem) => ({ ok: false as const, problem, message: VERIFICATION_MESSAGES[problem] });
  const method = (raw.method ?? "").trim();
  const contact = (raw.contact ?? "").trim();
  const note = (raw.note ?? "").replace(/\r\n?/g, "\n").trim();
  const onFile = raw.contactOnFileBefore === true || raw.contactOnFileBefore === "on" || raw.contactOnFileBefore === "true";

  if (contact.length > VERIFICATION_CONTACT_MAX || CONTROL.test(contact) || LINK.test(contact)) return refuse("text");
  if (note.length > VERIFICATION_NOTE_MAX || CONTROL_BUT_LINE_BREAK.test(note) || LINK.test(note)) return refuse("text");

  if (method === "") {
    if (lockOn || contact !== "" || note !== "" || onFile) return refuse("method");
    return { ok: true, verification: null };
  }
  if (!isMethod(method)) return refuse("method");
  if (lockOn && (method === "call" || method === "message")) {
    if (contact === "") return refuse("contact");
    if (!onFile) return refuse("contact_not_on_file");
  }
  if (lockOn && method === "other" && note === "") return refuse("note");
  return { ok: true, verification: { method, contact: contact === "" ? null : contact, contactOnFileBefore: onFile, note: note === "" ? null : note } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lookalike addresses (PL6)

export interface LookalikeRow {
  id: string;
  name: string;
  address: string | null;
  /** The chain it is paid on, as the caller names it (the workspace's own when it has none). */
  chain: string;
}

export interface Lookalike {
  /** `same`: the very address another counterparty has; `alike`: another address with the same first 6 and last 4 hex digits. */
  kind: "same" | "alike";
  id: string;
  name: string;
}

const EVM = /^0x[0-9a-f]{40}$/;

/**
 * For each counterparty whose address is another's, or made to look like it, the others it matches (PL6). Two addresses
 * look alike when they differ but share the first 6 and the last 4 hex digits after `0x`, the pattern address poisoning
 * uses. Only addresses on the same chain are compared; case is ignored. Never a refusal: two counterparties can share a
 * wallet on purpose.
 */
export function lookalikes(rows: ReadonlyArray<LookalikeRow>): Map<string, Lookalike[]> {
  const buckets = new Map<string, Array<LookalikeRow & { key: string }>>();
  for (const row of rows) {
    const address = (row.address ?? "").toLowerCase();
    if (!EVM.test(address)) continue;
    const bucket = `${row.chain}|${address.slice(2, 8)}|${address.slice(-4)}`;
    const list = buckets.get(bucket);
    const entry = { ...row, key: address };
    if (list) list.push(entry);
    else buckets.set(bucket, [entry]);
  }
  const found = new Map<string, Lookalike[]>();
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (const row of list) {
      const matches = list
        .filter((other) => other.id !== row.id)
        .map((other) => ({ kind: other.key === row.key ? ("same" as const) : ("alike" as const), id: other.id, name: other.name }));
      if (matches.length > 0) found.set(row.id, matches);
    }
  }
  return found;
}

/** Whether two different EVM addresses share their first 6 and last 4 hex digits, case ignored (PL6). */
export function looksAlike(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  return EVM.test(x) && EVM.test(y) && x !== y && x.slice(2, 8) === y.slice(2, 8) && x.slice(-4) === y.slice(-4);
}

/**
 * The address this payee had or was paid at before that its current one is made to look like, or null (PL6): the way
 * address poisoning gets past the person confirming, who compares the ends with an address they know. `entries` are the
 * payee's address entries (new payee check N2); `paidTo` the addresses it was paid at, lowercase.
 */
export function earlierLookalike(
  address: string | null,
  entries: ReadonlyArray<{ action: string; detail: Record<string, unknown> }>,
  paidTo: Iterable<string> = []
): string | null {
  if (!address) return null;
  const earlier = new Set<string>(paidTo);
  for (const entry of entries) {
    for (const value of [entry.detail.from, entry.detail.to, entry.detail.address]) if (typeof value === "string") earlier.add(value.toLowerCase());
  }
  for (const candidate of earlier) if (looksAlike(address, candidate)) return candidate;
  return null;
}

/** What Counterparties and the confirm form say about an address made to look like one the payee had before. */
export const EARLIER_LOOKALIKE = "Looks like an earlier address of this payee";

/** What Counterparties and the confirm form say about a lookalike. */
export function lookalikeWords(match: Lookalike): string {
  return match.kind === "same" ? `Same address as ${match.name}` : `Looks like ${match.name}'s address`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Changing the setting (PL1)

export type PayeeLockErrorCode = "invalid" | "unchanged" | "cycle_running" | "not_ready";

const MESSAGES: Record<PayeeLockErrorCode, string> = {
  invalid: `Choose a wait from 0 to ${COOLING_HOURS_MAX} hours.`,
  unchanged: "The payee lock is already set this way.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  not_ready: "The payee lock is not available in this workspace yet.",
};

export class PayeeLockError extends Error {
  constructor(readonly code: PayeeLockErrorCode) {
    super(MESSAGES[code]);
    this.name = "PayeeLockError";
  }
}

function summary(from: PayeeLock, to: PayeeLock): string {
  const wait = (hours: number) => (hours > 0 ? `, with a ${hours}-hour wait after an address changes` : "");
  if (!to.on && !from.on) return `Changed the payee lock's wait after an address changes from ${from.coolingHours} to ${to.coolingHours} hours, with the lock off`;
  if (!to.on) return "Turned off the payee lock";
  if (!from.on) return `Turned on the payee lock${wait(to.coolingHours)}`;
  return `Changed the payee lock's wait after an address changes from ${from.coolingHours} to ${to.coolingHours} hours`;
}

/**
 * An owner turns the lock on or off, or changes its cooling-off (PL1), signed as `payee_lock_changed`. Refused while a
 * cycle runs, as the two approvals figure is: the cycle read the lock when it began. A wait is kept while the lock is
 * off, and applies only once it is on.
 */
export async function changePayeeLock(input: { actorId: string; on: boolean; coolingHours: number }): Promise<{ from: PayeeLock; to: PayeeLock }> {
  if (!Number.isInteger(input.coolingHours) || input.coolingHours < 0 || input.coolingHours > COOLING_HOURS_MAX) throw new PayeeLockError("invalid");
  const to: PayeeLock = { on: input.on, coolingHours: input.coolingHours };

  const { lock: from, ready } = await readPayeeLockStatus(db());
  if (!ready) throw new PayeeLockError("not_ready");
  if (from.on === to.on && from.coolingHours === to.coolingHours) throw new PayeeLockError("unchanged");

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new PayeeLockError("cycle_running");

  // A write that asks for nothing back: only its error says whether it happened.
  const write = await db()
    .from("approval_policies")
    .upsert(
      { payee_lock: to.on, payee_lock_cooling_hours: to.coolingHours, updated_by: input.actorId, updated_at: new Date().toISOString() },
      { onConflict: "org_id" }
    );
  if (write.error) {
    if (payeeLockColumnsMissing(write.error)) throw new PayeeLockError("not_ready");
    throw new Error(write.error.message);
  }

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "payee_lock_changed",
    summary: summary(from, to),
    detail: { by: input.actorId, from, to },
  });

  return { from, to };
}
