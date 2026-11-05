/**
 * The call to make before paying an invoice (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC6): who to
 * call, on which number, and what to ask, naming what changed. Plain text with placeholders, built in the browser; no
 * value typed into the page is put in a link.
 */

export interface CallScriptInput {
  /** The vendor's name on file, or the invoice's when none is on file. */
  vendor: string | null;
  /** The phone number on file, if any. */
  phoneOnFile: string | null;
  /** The ways to be paid that changed or are new: "bank account", "wallet address". */
  changed: readonly string[];
  /** Whether a change of payment details was found or asked for, in the fields or in the message. */
  asked: boolean;
  /** Whether the invoice gives a wallet address, so the script says how to read one back. */
  wallet: boolean;
}

/** Someone's text on one line, at most `max` characters. */
const line = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
};

const list = (nouns: readonly string[]) => (nouns.length <= 1 ? nouns.join("") : `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`);

/** The script, as lines of plain text (IC6). */
export function callScript({ vendor, phoneOnFile, changed, asked, wallet }: CallScriptInput): string[] {
  const who = vendor ? line(vendor, 60) : "the vendor";
  const number = phoneOnFile
    ? `Call ${line(phoneOnFile, 40)}, the number you already had.`
    : "Call a number from your own records, a past invoice you paid, or the vendor's website typed in yourself, not one from a link or a search ad.";
  const step2 = !asked
    ? `2. "Before we pay it, can you confirm where you want to be paid?"`
    : changed.length > 0
      ? `2. "We received a request to pay you at a new ${list(changed)}. Did you make that change?"`
      : `2. "We received an email asking us to change where we pay you. Did your company send it?"`;
  const readBack = wallet ? " For a wallet address, ask them to read the whole address, or at least its first 6, its last 6 and 6 from the middle." : "";
  return [
    `Call ${who} before you pay this invoice.`,
    `${number} Do not use a phone number, link or email address from this invoice or the message that came with it.`,
    `1. "Hi, this is [your name] from [your business]. Can I speak to [the person you usually deal with]? I'm calling about your invoice [invoice number]."`,
    step2,
    `3. "Could you read me the details you want us to pay?" Let them read them out; never read them out first.${readBack} Check them against the invoice as they read: if one character differs, do not pay.`,
    asked ? `4. "Who at your company made the change, and when?"` : `4. "Who should we call if these details ever change?"`,
    asked
      ? "5. If they did not make the change, do not pay and do not reply to the email. Forward it to them so they can secure their mailbox. If money was already sent, call your bank now and ask them to recall it: the first day matters. In the US, report it to the FBI at ic3.gov."
      : "5. If the details they read out are not the ones on this invoice, do not pay.",
    "Write down who you spoke to, the number you called, and the time. Update your records only after this call.",
  ];
}
