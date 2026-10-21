import { SIGNED_ENTRY_PROVES } from "./evidence-chain";
import { CHECK_AN_ENTRY, type EvidenceKey } from "./evidence-export";
import type { LedgerRow } from "./ledger";
import { networkProfile, type Network } from "./network";
import { txUrl } from "./payee-chains";
import { VERIFICATION_LABELS, type PayeeLock, type VerificationMethod } from "./payee-lock-rules";
import type { EntryCheck } from "./receipts/verify";

/**
 * The payee lock's evidence pack (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md): every payout
 * address change in a period, with who entered it, how it was checked and by whom, what it held back, and the first
 * payment to it, each fact citing the signed entries it rests on, which the file carries in full. Pure: the reader
 * (`./payee-lock-evidence-read`) gathers the entries, and the route gates who may download it.
 */

export const PAYEE_LOCK_EVIDENCE_FORMAT = "vestiarion-payee-lock-evidence/1";

/** The rules that hold a payment back for its address (EP2). */
export const ADDRESS_HOLD_RULES = ["counterparty.address_unconfirmed", "counterparty.cooling_off", "counterparty.new_payee"] as const;
const HOLD_RULES: ReadonlySet<string> = new Set(ADDRESS_HOLD_RULES);
/** The entries a person's decision writes when it pays (EP2): a shadow-mode verdict that pays writes `approval_paid`. */
const PERSON_PAID = new Set(["approval_paid", "milestone_approval_paid"]);

/** An entry with the server's own check of its signature and chain link. */
export type CheckedEntry = LedgerRow & { check?: EntryCheck };

export type Who =
  | { kind: "member"; email: string }
  | { kind: "former_member"; id: string }
  | { kind: "payee_link"; linkId: string | null }
  | { kind: "github"; login: string | null }
  | { kind: "unknown" };

export interface PayeeLockEvidenceInput {
  workspace: { slug: string; name: string };
  network: Network;
  period: Period;
  lock: PayeeLock;
  /** The address changes and lock changes in the period, and every entry of the counterparties they name. */
  entries: readonly CheckedEntry[];
  /** Counterparty names, by id. */
  counterparties: ReadonlyMap<string, string>;
  /** Members' emails, by user id. */
  members: ReadonlyMap<string, string>;
  keys: EvidenceKey[];
  now: Date;
}

/** A period of whole UTC days, either end open (EP1). */
export interface Period {
  from: string | null;
  to: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The period a request asks for, or null when a day is malformed or the ends are reversed (EP1). */
export function parsePeriod(from: string | null, to: string | null): Period | null {
  const day = (value: string | null) => {
    if (value === null || value === "") return null;
    if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return undefined;
    return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : undefined;
  };
  const start = day(from);
  const end = day(to);
  if (start === undefined || end === undefined) return null;
  if (start !== null && end !== null && start > end) return null;
  return { from: start, to: end };
}

/** Whether a timestamp falls within the period: from the first day's start to the last day's end, UTC. */
export function inPeriod(ts: string, period: Period): boolean {
  const at = Date.parse(ts);
  if (period.from !== null && at < Date.parse(`${period.from}T00:00:00Z`)) return false;
  if (period.to !== null && at >= Date.parse(`${period.to}T00:00:00Z`) + 86_400_000) return false;
  return true;
}

/** `vestiarion-payee-lock-evidence-pinecrest-studio-2026-10-01-2026-10-31.json`; `all` and `now` for open ends. */
export function payeeLockEvidenceFileName(slug: string, period: Period, extension: "json" | "csv" = "json"): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "workspace";
  return `vestiarion-payee-lock-evidence-${safe}-${period.from ?? "all"}-${period.to ?? "now"}.${extension}`;
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const same = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

function person(id: unknown, members: ReadonlyMap<string, string>): Who {
  const userId = str(id);
  if (!userId) return { kind: "unknown" };
  const email = members.get(userId);
  return email ? { kind: "member", email } : { kind: "former_member", id: userId.slice(0, 8) };
}

/** Who entered an address, as its change entry names them (EP2). */
function enteredBy(detail: Record<string, unknown>, members: ReadonlyMap<string, string>): Who {
  if (detail.via === "payee_link") return { kind: "payee_link", linkId: str(detail.linkId) };
  if (detail.via === "github") return { kind: "github", login: str(detail.login) };
  return person(detail.by, members);
}

/** The transaction an entry names, if any: a payment's or one it reconciles. */
function txRefOf(entry: CheckedEntry): string | null {
  return str(record(entry.detail.execution)?.txRef) ?? str(entry.detail.txRef);
}

/**
 * A payment the entry records to an address on chain: a transaction sent or settled (`paid`, `matched`, or `verified`
 * for a milestone in flight). A bank payout is not one: the lock does not cover it (EP2).
 */
function paymentOf(entry: CheckedEntry): { txRef: string; amount: number | null; currency: string } | null {
  const execution = record(entry.detail.execution);
  const txRef = txRefOf(entry);
  const status = str(execution?.resultingStatus) ?? str(entry.detail.status);
  if (!txRef || !status || !["paid", "matched", "verified"].includes(status)) return null;
  if (record(entry.detail.payout)?.route === "bank" || execution?.bankPayout) return null;
  const observed = record(entry.detail.observed);
  const raw = entry.detail.amountPaid ?? entry.detail.amount ?? observed?.amount;
  const amount = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  return { txRef, amount: amount !== null && Number.isFinite(amount) ? amount : null, currency: str(entry.detail.currency) ?? "USDC" };
}

/** The rule that held a payment back for its address, if this entry records one (EP2). */
function holdRuleOf(entry: CheckedEntry): string | null {
  const rule = str(entry.detail.guardrailRule) ?? str(entry.detail.notResubmittedBecause);
  return rule && HOLD_RULES.has(rule) ? rule : null;
}

function subjectOf(entry: CheckedEntry): { kind: "invoice" | "milestone"; id: string } | null {
  const invoiceId = str(entry.detail.invoiceId);
  if (invoiceId) return { kind: "invoice", id: invoiceId };
  const milestoneId = str(entry.detail.milestoneId);
  return milestoneId ? { kind: "milestone", id: milestoneId } : null;
}

const methodOf = (value: unknown): VerificationMethod | null =>
  typeof value === "string" && Object.hasOwn(VERIFICATION_LABELS, value) ? (value as VerificationMethod) : null;

/**
 * Whether someone other than whoever entered the address confirmed it (EP2): true only when that is known. With the
 * lock on, the confirmation itself checked who gave the address and refused them while another member could confirm,
 * failing closed, so its flags answer. With the lock off it checked only when confirmed with Confirm address, best
 * effort, so a different member is the only proof; a payee link or GitHub giver, or a confirmation by approving, is not
 * known either way.
 */
function secondPersonOf(change: CheckedEntry, confirmed: CheckedEntry | undefined): boolean | null {
  if (!confirmed) return null;
  const detail = confirmed.detail;
  if (detail.soloConfirmation === true || detail.byGiver === true) return false;
  const confirmer = str(detail.by);
  const giver = str(change.detail.by);
  if (confirmer && giver && confirmer === giver) return false;
  if (detail.giverUnknown === true) return null;
  if (record(detail.payeeLock)) return true;
  return confirmer && giver && change.detail.via === undefined ? true : null;
}

export function payeeLockEvidence(input: PayeeLockEvidenceInput) {
  const sorted = [...input.entries].sort((a, b) => a.seq - b.seq);
  const cited = new Set<number>();
  const cite = (entry: CheckedEntry) => {
    cited.add(entry.seq);
    return entry.seq;
  };
  const counterpartyOf = (entry: CheckedEntry) => str(entry.detail.counterpartyId);
  const isChange = (entry: CheckedEntry) => entry.action === "counterparty_address_changed";

  // A mirror address Vestiarion made in shadow mode is not a payee's change, and needs no confirmation (EP2).
  const changes = sorted
    .filter(
      (entry) =>
        isChange(entry) && entry.detail.via !== "mirror" && str(entry.detail.to) !== null && counterpartyOf(entry) !== null && inPeriod(entry.ts, input.period)
    )
    .map((change) => {
      const counterpartyId = counterpartyOf(change) as string;
      const to = str(change.detail.to);
      const next = sorted.find((entry) => entry.seq > change.seq && isChange(entry) && counterpartyOf(entry) === counterpartyId);
      const window = sorted.filter(
        (entry) => entry.seq > change.seq && (next === undefined || entry.seq < next.seq) && counterpartyOf(entry) === counterpartyId
      );

      const confirmed = window.find(
        (entry) => entry.action === "counterparty_address_confirmed" && (str(entry.detail.address) === null || same(str(entry.detail.address), to))
      );
      // A transfer the counterparty's earlier entries already named went to the address it had then: reconciling it, or
      // approving it once sent, is not a payment to this one (EP2).
      const sentBefore = new Set(
        sorted.filter((entry) => entry.seq < change.seq && counterpartyOf(entry) === counterpartyId).flatMap((entry) => txRefOf(entry) ?? [])
      );
      const paid = window.find((entry) => {
        const payment = paymentOf(entry);
        return payment !== null && !sentBefore.has(payment.txRef);
      });
      const holds = window.filter((entry) => (paid === undefined || entry.seq < paid.seq) && holdRuleOf(entry) !== null);

      const lock = record(confirmed?.detail.payeeLock);
      const waitHours = typeof lock?.coolingHours === "number" && lock.coolingHours > 0 ? lock.coolingHours : null;
      const payableFrom = waitHours !== null ? new Date(Date.parse(change.ts) + waitHours * 3_600_000).toISOString() : null;
      const verification = record(confirmed?.detail.verification);
      const secondPerson = secondPersonOf(change, confirmed);
      const alike = Array.isArray(confirmed?.detail.lookalikeOf) ? (confirmed?.detail.lookalikeOf as unknown[]).flatMap((id) => (typeof id === "string" ? [id] : [])) : [];

      const payment = paid ? paymentOf(paid) : null;
      const method = methodOf(verification?.method);

      return {
        counterparty: { id: counterpartyId, name: input.counterparties.get(counterpartyId) ?? null },
        change: {
          at: change.ts,
          from: str(change.detail.from),
          to,
          chain: str(change.detail.chain),
          enteredBy: enteredBy(change.detail, input.members),
          entry: cite(change),
        },
        confirmation: confirmed
          ? {
              at: confirmed.ts,
              by: person(confirmed.detail.by, input.members),
              // With Confirm address (`confirm`), which checks for lookalikes, or by approving a payment to it (`approval`).
              via: str(confirmed.detail.via),
              record: verification
                ? {
                    method,
                    methodLabel: method ? VERIFICATION_LABELS[method] : null,
                    contact: str(verification.contact),
                    contactOnFileBefore: verification.contactOnFileBefore === true,
                    note: str(verification.note),
                  }
                : null,
              secondPerson,
              soloConfirmation: confirmed.detail.soloConfirmation === true,
              byGiver: confirmed.detail.byGiver === true,
              giverUnknown: confirmed.detail.giverUnknown === true,
              waitHours,
              payableFrom,
              lookalikeOf: alike.map((id) => ({ id, name: input.counterparties.get(id) ?? null })),
              looksLikeEarlier: str(confirmed.detail.looksLikeEarlier),
              entry: cite(confirmed),
            }
          : null,
        holds: holds.map((entry) => ({ at: entry.ts, rule: holdRuleOf(entry) as string, subject: subjectOf(entry), entry: cite(entry) })),
        firstPayment:
          paid && payment
            ? {
                at: paid.ts,
                amount: payment.amount,
                currency: payment.currency,
                txRef: payment.txRef,
                txUrl: /^0x[0-9a-fA-F]{64}$/.test(payment.txRef) ? txUrl(input.network, payment.txRef) : null,
                decidedBy: PERSON_PAID.has(paid.action) ? ("person" as const) : ("agent" as const),
                subject: subjectOf(paid),
                entry: cite(paid),
              }
            : null,
        checks: {
          recordKept: confirmed ? verification !== null : null,
          contactOnFileBefore: confirmed ? verification?.contactOnFileBefore === true : null,
          secondPerson,
          paidAfterConfirmation: paid ? confirmed !== undefined && confirmed.seq < paid.seq : null,
          paidAfterWait: paid && payableFrom !== null ? Date.parse(paid.ts) >= Date.parse(payableFrom) : null,
        },
      };
    });

  const lockChanges = sorted
    .filter((entry) => entry.action === "payee_lock_changed" && inPeriod(entry.ts, input.period))
    .map((entry) => ({ at: entry.ts, by: person(entry.detail.by, input.members), from: entry.detail.from ?? null, to: entry.detail.to ?? null, entry: cite(entry) }));

  const count = (test: (row: (typeof changes)[number]) => boolean) => changes.filter(test).length;
  const heldFor = (rule: string) => count((row) => row.holds.some((hold) => hold.rule === rule));

  return {
    format: PAYEE_LOCK_EVIDENCE_FORMAT,
    exportedAt: input.now.toISOString(),
    workspace: input.workspace,
    network: { id: input.network, label: networkProfile(input.network).label },
    period: input.period,
    lock: { now: input.lock, changes: lockChanges },
    summary: {
      changes: changes.length,
      confirmed: count((row) => row.confirmation !== null),
      confirmedWithRecord: count((row) => row.checks.recordKept === true),
      confirmedBySecondPerson: count((row) => row.checks.secondPerson === true),
      heldWhileUnconfirmed: heldFor("counterparty.address_unconfirmed"),
      heldForTheWait: heldFor("counterparty.cooling_off"),
      heldAsNewPayee: heldFor("counterparty.new_payee"),
      paid: count((row) => row.firstPayment !== null),
      paidOnlyAfterConfirmation: count((row) => row.checks.paidAfterConfirmation === true),
    },
    changes,
    signedEntryProves: SIGNED_ENTRY_PROVES,
    checkAnEntry: CHECK_AN_ENTRY,
    keys: input.keys,
    entries: sorted
      .filter((entry) => cited.has(entry.seq))
      .map((entry) => ({
        seq: entry.seq,
        id: entry.id ?? null,
        ts: entry.ts,
        actor: entry.actor,
        domain: entry.domain,
        action: entry.action,
        summary: entry.summary,
        detail: entry.detail,
        body_hash: entry.body_hash,
        signature: entry.signature,
        prev_hash: entry.prev_hash,
        hash: entry.hash,
        signing_key_id: entry.signing_key_id,
        check: (entry.check ?? null) as EntryCheck | null,
      })),
  };
}

export type PayeeLockEvidence = ReturnType<typeof payeeLockEvidence>;
