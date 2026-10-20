/**
 * The payee lock's rules that touch no database (docs/superpowers/specs/2026-10-20-payee-lock-design.md): the setting's
 * shape, the cooling-off, the record of how an address was checked (PL2) and lookalike addresses (PL6). Pure, so the
 * browser's components (Confirm address, Settings) import them without the server's modules; ./payee-lock re-exports
 * them beside what reads and writes the setting.
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

/** A lock as its `approval_policies` row holds it; no row, or no columns in it, is off. */
export function payeeLockFromRow(row: { payee_lock?: boolean | null; payee_lock_cooling_hours?: number | string | null } | undefined): PayeeLock {
  if (!row) return PAYEE_LOCK_OFF;
  const hours = Number(row.payee_lock_cooling_hours ?? 0);
  return { on: row.payee_lock === true, coolingHours: Number.isInteger(hours) && hours >= 0 ? Math.min(hours, COOLING_HOURS_MAX) : 0 };
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
