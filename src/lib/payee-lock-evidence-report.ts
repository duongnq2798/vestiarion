import { csvCell } from "./ledger-export";
import { parsePeriod, type PayeeLockEvidence, type Period, type Who } from "./payee-lock-evidence";

/**
 * The payee lock's evidence pack read for people (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md
 * EP7-EP9): who did each step in words, the answers the pack gives to the questions insurers ask about changed payment
 * details, and one CSV row per address change. Pure: the page and the route render what it returns.
 */

/**
 * Who did a step, in words: a member's email, or their user id when the pack names no one by email (evidence API EA3),
 * "a former member (1a2b3c4d)", "the payee, through a payee link".
 */
export function whoWords(who: Who): string {
  if (who.kind === "member") return who.email ?? who.userId;
  if (who.kind === "former_member") return `a former member (${who.id})`;
  if (who.kind === "payee_link") return "the payee, through a payee link";
  if (who.kind === "github") return who.login ? `GitHub (${who.login})` : "GitHub";
  return "unknown";
}

const DAY = 86_400_000;

/** The last 30 days, in whole UTC days, ending today. */
export function last30Days(now: Date): Period {
  return { from: new Date(now.getTime() - 29 * DAY).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

/**
 * The period the page shows (EP7): `all=1` for all time, `from` and `to` as the file reads them, the last 30 days when
 * neither is given. A value given twice, or a day that cannot be read, shows the last 30 days and says so.
 */
export function evidencePeriodFrom(query: Record<string, string | string[] | undefined>, now: Date): { period: Period; unreadable: boolean } {
  const values = [query.from, query.to, query.all];
  if (values.some((value) => Array.isArray(value))) return { period: last30Days(now), unreadable: true };
  if (query.all === "1") return { period: { from: null, to: null }, unreadable: false };
  const from = (query.from as string | undefined) ?? "";
  const to = (query.to as string | undefined) ?? "";
  if (from === "" && to === "") return { period: last30Days(now), unreadable: false };
  const period = parsePeriod(from, to);
  return period ? { period, unreadable: false } : { period: last30Days(now), unreadable: true };
}

/** How an address was confirmed, in words: with Confirm address, or by approving a payment to it. */
export function viaWords(via: string | null): string {
  if (via === "confirm") return "Confirm address";
  if (via === "approval") return "approving a payment to it";
  return "not recorded";
}

export type Answer = "yes" | "partly" | "no" | "not_seen";

export const ANSWER_WORDS: Record<Answer, string> = { yes: "Yes", partly: "Partly", no: "No", not_seen: "Nothing to show yet" };

/** What the answers are, and are not: said beside them wherever they are shown. */
export const QUESTIONS_NOTE =
  "Counted from these records, not a completed questionnaire. A confirmation's method and whether its contact was on file before the change are what the person confirming recorded.";

export interface QuestionAnswer {
  id: "callback" | "second_person" | "record" | "hold" | "wait" | "lookalike" | "independent";
  /** The control, in our words: each insurer words its own questionnaire. */
  question: string;
  answer: Answer;
  /** What the records of these changes show. */
  evidence: string;
  /** How Vestiarion works now, as the workspace is set up today, which may differ from when a change was made. */
  how: string;
}

/** `yes` when every case counted passes, `partly` when some do, `no` when none, `not_seen` when there is no case. */
function share(passed: number, of: number): Answer {
  if (of === 0) return "not_seen";
  return passed === of ? "yes" : passed > 0 ? "partly" : "no";
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const CALL_OR_MESSAGE = new Set(["call", "message"]);

/**
 * The answers the pack gives to the controls insurers' questionnaires on payment-change fraud ask about (EP8): a
 * call-back to a contact held before the change, a second person, a record of the check, a hold until it is confirmed,
 * a wait, lookalike addresses, and records someone outside can check. Each answer counts the pack's address changes
 * from their own records, never the lock's setting today, and a pack with no case answers nothing as yes. A change's
 * holds and first payment run to its next change, which can be after the period ends.
 */
export function payeeLockQuestions(pack: PayeeLockEvidence): QuestionAnswer[] {
  const rows = pack.changes;
  const confirmed = rows.filter((row) => row.confirmation !== null);
  const paidRows = rows.filter((row) => row.firstPayment !== null);
  const count = (list: typeof rows, test: (row: (typeof rows)[number]) => boolean) => list.filter(test).length;
  const lock = pack.lock.now;
  const now = lock.on
    ? `Now the payee lock is on${lock.coolingHours > 0 ? `, with a ${lock.coolingHours}-hour wait` : ", with no wait"}`
    : "Now the payee lock is off";

  const callBack = count(confirmed, (row) => CALL_OR_MESSAGE.has(row.confirmation?.record?.method ?? "") && row.checks.contactOnFileBefore === true);
  const second = count(confirmed, (row) => row.checks.secondPerson === true);
  const secondUnknown = count(confirmed, (row) => row.checks.secondPerson === null);
  const recorded = count(confirmed, (row) => row.checks.recordKept === true);
  const paidAfterConfirmation = count(paidRows, (row) => row.checks.paidAfterConfirmation === true);
  const holds = rows.reduce((total, row) => total + row.holds.length, 0);
  const paidAfterWait = count(paidRows, (row) => row.checks.paidAfterWait === true);
  // Confirm address checks for lookalikes before anyone confirms; approving a payment does not show them.
  const viaConfirm = confirmed.filter((row) => row.confirmation?.via === "confirm");
  const warned = count(viaConfirm, (row) => (row.confirmation?.lookalikeOf.length ?? 0) > 0 || (row.confirmation?.looksLikeEarlier ?? null) !== null);
  const verified = pack.entries.filter((entry) => entry.check?.ok === true).length;

  return [
    {
      id: "callback",
      question: "Before paying changed payment details, do you call or message the payee on contact details you already held?",
      answer: share(callBack, confirmed.length),
      evidence: `${callBack} of ${plural(confirmed.length, "confirmation")} recorded a call or a message to a contact the person confirming marked as on file before the change.`,
      how: `${now}. With it on, Confirm address refuses a call or a message without a contact on file before the new address arrived.`,
    },
    {
      id: "second_person",
      question: "Is each change confirmed by someone other than the person who requested or entered it?",
      answer: share(second, confirmed.length),
      evidence: `${second} of ${plural(confirmed.length, "confirmation")} came from someone other than whoever entered the address${secondUnknown > 0 ? `; for ${secondUnknown} it is not known` : ""}.`,
      how: `${now}. With it on, whoever entered or asked for an address cannot confirm it while another member can, and a confirmation made alone says so.`,
    },
    {
      id: "record",
      question: "Do you keep a record of each check: who made it, when, and how?",
      answer: share(recorded, confirmed.length),
      evidence: `${recorded} of ${plural(confirmed.length, "confirmation")} recorded how the address was checked, beside who confirmed it and when.`,
      how: `Each confirmation is a signed ledger entry naming who confirmed and when. ${now}; with it on, a confirmation must say how the address was checked.`,
    },
    {
      id: "hold",
      question: "Are payments to changed payment details held until the change is confirmed?",
      answer: paidRows.length > 0 ? share(paidAfterConfirmation, paidRows.length) : holds > 0 ? "yes" : "not_seen",
      evidence: `${paidAfterConfirmation} of ${plural(paidRows.length, "first payment")} to these addresses came after the address was confirmed, and the agent held ${plural(holds, "payment")} for them.`,
      how: "The agent holds every payment to a changed address until a person confirms it, whether the payee lock is on or off.",
    },
    {
      id: "wait",
      question: "Do changed payment details wait a set time before the first payment?",
      answer: share(paidAfterWait, paidRows.length),
      evidence: `${paidAfterWait} of ${plural(paidRows.length, "first payment")} to these addresses came after a payee lock wait recorded with its confirmation had ended.`,
      how: `${now}. An owner can set a wait of 4, 24, 48 or 72 hours after an address changes, confirmed or not, in Settings.`,
    },
    {
      id: "lookalike",
      question: "Do you look for payment details made to resemble a known payee's?",
      answer: share(viaConfirm.length, confirmed.length),
      evidence: `${viaConfirm.length} of ${plural(confirmed.length, "confirmation")} went through Confirm address, which checks for lookalikes before anyone confirms; it warned on ${warned}.`,
      how: "Counterparties and Confirm address warn when an address shares its first 6 and last 4 characters with another payee's, or with an earlier one of the same payee. Approving a payment does not show the warning.",
    },
    {
      id: "independent",
      question: "Can you produce these records, and can someone outside check them?",
      answer: share(verified, pack.entries.length),
      evidence: `${verified} of ${plural(pack.entries.length, "ledger entry", "ledger entries")} this pack cites verified against the workspace's keys.`,
      how: "The JSON file carries every entry it cites, signed with Ed25519, and the public keys, so anyone can check it offline.",
    },
  ];
}

/** The CSV's columns, one row per address change (EP9). */
export const PAYEE_LOCK_CSV_FIELDS = [
  "counterparty",
  "counterparty_id",
  "changed_at",
  "from_address",
  "to_address",
  "chain",
  "entered_by",
  "confirmed_at",
  "confirmed_by",
  "confirmed_with",
  "check_method",
  "contact_used",
  "contact_on_file_before",
  "check_note",
  "second_person",
  "confirmed_alone",
  "wait_hours",
  "payable_from",
  "lookalike_of",
  "looks_like_earlier",
  "holds",
  "first_payment_at",
  "amount",
  "currency",
  "tx_ref",
  "tx_url",
  "decided_by",
  "paid_after_confirmation",
  "paid_after_wait",
  "change_entry",
  "confirmation_entry",
  "hold_entries",
  "payment_entry",
] as const;

const yesNo = (value: boolean | null | undefined) => (value === true ? "yes" : value === false ? "no" : "");

/**
 * The pack as CSV (EP9): one row per address change, the columns `PAYEE_LOCK_CSV_FIELDS` names, each cell guarded
 * against running as a spreadsheet formula. A byte-order mark first, so Excel reads it as UTF-8. The entries' signatures
 * stay in the JSON file, which the CSV's entry numbers point into.
 */
export function payeeLockEvidenceCsv(pack: PayeeLockEvidence): string {
  const lines = [PAYEE_LOCK_CSV_FIELDS.join(",")];
  for (const row of pack.changes) {
    const confirmation = row.confirmation;
    const payment = row.firstPayment;
    const holdCounts = new Map<string, number>();
    for (const hold of row.holds) holdCounts.set(hold.rule, (holdCounts.get(hold.rule) ?? 0) + 1);
    const cells: Record<(typeof PAYEE_LOCK_CSV_FIELDS)[number], unknown> = {
      counterparty: row.counterparty.name,
      counterparty_id: row.counterparty.id,
      changed_at: row.change.at,
      from_address: row.change.from,
      to_address: row.change.to,
      chain: row.change.chain,
      entered_by: whoWords(row.change.enteredBy),
      confirmed_at: confirmation?.at,
      confirmed_by: confirmation ? whoWords(confirmation.by) : null,
      confirmed_with: confirmation ? viaWords(confirmation.via) : null,
      check_method: confirmation?.record?.methodLabel,
      contact_used: confirmation?.record?.contact,
      contact_on_file_before: confirmation ? yesNo(row.checks.contactOnFileBefore) : null,
      check_note: confirmation?.record?.note,
      second_person: yesNo(row.checks.secondPerson),
      confirmed_alone: confirmation ? yesNo(confirmation.soloConfirmation) : null,
      wait_hours: confirmation?.waitHours,
      payable_from: confirmation?.payableFrom,
      lookalike_of: confirmation?.lookalikeOf.map((other) => other.name ?? other.id).join("; "),
      looks_like_earlier: confirmation?.looksLikeEarlier,
      holds: [...holdCounts].map(([rule, times]) => `${rule} x${times}`).join("; "),
      first_payment_at: payment?.at,
      amount: payment?.amount,
      currency: payment?.currency,
      tx_ref: payment?.txRef,
      tx_url: payment?.txUrl,
      decided_by: payment?.decidedBy,
      paid_after_confirmation: yesNo(row.checks.paidAfterConfirmation),
      paid_after_wait: yesNo(row.checks.paidAfterWait),
      change_entry: row.change.entry,
      confirmation_entry: confirmation?.entry,
      hold_entries: row.holds.map((hold) => hold.entry).join(" "),
      payment_entry: payment?.entry,
    };
    lines.push(PAYEE_LOCK_CSV_FIELDS.map((field) => csvCell(cells[field])).join(","));
  }
  return `\ufeff${lines.join("\r\n")}\r\n`;
}
