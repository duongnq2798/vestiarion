import { csvCell } from "./ledger-export";
import type { PayeeLockEvidence, Who } from "./payee-lock-evidence";

/**
 * The payee lock's evidence pack read for people (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md
 * EP7-EP9): who did each step in words, the answers the pack gives to the questions insurers ask about changed payment
 * details, and one CSV row per address change. Pure: the page and the route render what it returns.
 */

/** Who did a step, in words: a member's email, "a former member (1a2b3c4d)", "the payee, through a payee link". */
export function whoWords(who: Who): string {
  if (who.kind === "member") return who.email;
  if (who.kind === "former_member") return `a former member (${who.id})`;
  if (who.kind === "payee_link") return "the payee, through a payee link";
  if (who.kind === "github") return who.login ? `GitHub (${who.login})` : "GitHub";
  return "unknown";
}

export type Answer = "yes" | "partly" | "no" | "not_seen";

export const ANSWER_WORDS: Record<Answer, string> = { yes: "Yes", partly: "Partly", no: "No", not_seen: "Nothing to show yet" };

export interface QuestionAnswer {
  id: "callback" | "second_person" | "record" | "hold" | "wait" | "lookalike" | "independent";
  /** The control, in our words: each insurer words its own questionnaire. */
  question: string;
  answer: Answer;
  /** What this period's records show. */
  evidence: string;
  /** How Vestiarion makes it so, as the workspace is set up now. */
  how: string;
}

/** `yes` when every case counted passes, `partly` when some do, `no` when none, `not_seen` when there is no case. */
function share(passed: number, of: number): Answer {
  if (of === 0) return "not_seen";
  return passed === of ? "yes" : passed > 0 ? "partly" : "no";
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The answers the pack gives to the controls insurers' questionnaires on payment-change fraud ask about (EP8): a
 * call-back to a contact held before the change, a second person, a record of the check, a hold until it is confirmed,
 * a wait, lookalike addresses, and records someone outside can check. Each answer counts this period's address changes;
 * none is a claim about a change the pack does not hold.
 */
export function payeeLockQuestions(pack: PayeeLockEvidence): QuestionAnswer[] {
  const rows = pack.changes;
  const confirmed = rows.filter((row) => row.confirmation !== null);
  const count = (test: (row: (typeof rows)[number]) => boolean) => rows.filter(test).length;
  const lock = pack.lock.now;
  const waitHours = lock.on ? lock.coolingHours : 0;

  const contactBefore = count((row) => row.checks.contactOnFileBefore === true);
  const second = count((row) => row.checks.secondPerson === true);
  const secondUnknown = confirmed.filter((row) => row.checks.secondPerson === null).length;
  const recorded = count((row) => row.checks.recordKept === true);
  const paid = count((row) => row.firstPayment !== null);
  const paidAfterConfirmation = count((row) => row.checks.paidAfterConfirmation === true);
  const holds = rows.reduce((total, row) => total + row.holds.length, 0);
  const underWait = count((row) => row.checks.paidAfterWait !== null);
  const afterWait = count((row) => row.checks.paidAfterWait === true);
  const flagged = count((row) => (row.confirmation?.lookalikeOf.length ?? 0) > 0 || (row.confirmation?.looksLikeEarlier ?? null) !== null);
  const verified = pack.entries.filter((entry) => entry.check?.ok === true).length;

  const holdAnswer = paid > 0 ? share(paidAfterConfirmation, paid) : holds > 0 ? "yes" : "not_seen";
  const waitAnswer: Answer = waitHours === 0 ? "no" : underWait === 0 ? "yes" : share(afterWait, underWait);

  return [
    {
      id: "callback",
      question: "Before paying changed payment details, do you call or message the payee on contact details you already held?",
      answer: share(contactBefore, confirmed.length),
      evidence: `${contactBefore} of ${plural(confirmed.length, "confirmed address change")} ${contactBefore === 1 ? "was" : "were"} checked with a contact on file before the change.`,
      how: lock.on
        ? "With the payee lock on, Confirm address refuses a call or a message without a contact that was on file before the new address arrived."
        : "The payee lock is off, so Confirm address asks how the address was checked but does not require it.",
    },
    {
      id: "second_person",
      question: "Is each change confirmed by someone other than the person who requested or entered it?",
      answer: share(second, confirmed.length),
      evidence: `${second} of ${plural(confirmed.length, "confirmed change")} ${second === 1 ? "was" : "were"} confirmed by someone other than whoever entered the address${secondUnknown > 0 ? `; for ${secondUnknown} it is not known` : ""}.`,
      how: lock.on
        ? "With the payee lock on, whoever entered or asked for an address cannot confirm it while another member can. A confirmation made alone says so."
        : "The payee lock is off, so the person who entered an address may confirm it.",
    },
    {
      id: "record",
      question: "Do you keep a record of each check: who made it, when, and how?",
      answer: share(recorded, confirmed.length),
      evidence: `${recorded} of ${plural(confirmed.length, "confirmation")} recorded how the address was checked, and by whom.`,
      how: "Each confirmation is a signed ledger entry naming who confirmed and when; with the payee lock on, it must say how the address was checked.",
    },
    {
      id: "hold",
      question: "Are payments to changed payment details held until the change is confirmed?",
      answer: holdAnswer,
      evidence: `${paidAfterConfirmation} of ${plural(paid, "first payment")} to a changed address came after it was confirmed. The agent held ${plural(holds, "payment")} for an address in this period.`,
      how: "The agent holds every payment to a changed address until a person confirms it, whether the payee lock is on or off.",
    },
    {
      id: "wait",
      question: "Do changed payment details wait a set time before the first payment?",
      answer: waitAnswer,
      evidence:
        waitHours === 0
          ? "The payee lock sets no wait now."
          : `The payee lock waits ${waitHours} hours after a change. ${afterWait} of ${plural(underWait, "payment")} made under a wait came after it ended.`,
      how: "An owner sets a wait of 4, 24, 48 or 72 hours after an address changes, confirmed or not, in Settings.",
    },
    {
      id: "lookalike",
      question: "Do you look for payment details made to resemble a known payee's?",
      answer: "yes",
      evidence:
        flagged === 0
          ? `None of the ${plural(rows.length, "change")} looked like another payee's address or an earlier one of the same payee.`
          : `${flagged} of ${plural(rows.length, "change")} looked like another payee's address or an earlier one of the same payee, and Confirm address said so before anyone confirmed.`,
      how: "Counterparties and Confirm address warn when an address shares its first 6 and last 4 characters with another payee's, or with an earlier one of the same payee.",
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
  "check_method",
  "contact_used",
  "contact_on_file_before",
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
      check_method: confirmation?.record?.methodLabel,
      contact_used: confirmation?.record?.contact,
      contact_on_file_before: confirmation ? yesNo(row.checks.contactOnFileBefore) : null,
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
