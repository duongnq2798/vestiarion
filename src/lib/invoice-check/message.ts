import { invoiceService, readEmail, registered, type Email } from "./domain";

/**
 * The message that came with an invoice, read for the words a request to change payment details uses
 * (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC4). Pure and run in the browser.
 */

export type CueKind = "change" | "pressure" | "no_call" | "secrecy" | "reason";

export interface Cue {
  kind: CueKind;
  /** The words as the message wrote them, on one line. */
  phrase: string;
}

export interface MessageRead {
  cues: Cue[];
  /** The sender from a pasted `From:` line, if any. */
  from: Email | null;
  /** A pasted header's From and Reply-To domains, when they differ and the From is not an invoicing service. */
  replyTo: { from: string; replyTo: string } | null;
}

/** At most this much of a message is read. */
export const MESSAGE_MAX = 20_000;

/** Curly apostrophes, read as the straight one so "don't" is found however it was typed. */
const APOSTROPHES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x02bc)}]`, "g");

const CUES: ReadonlyArray<{ kind: CueKind; pattern: RegExp }> = [
  {
    kind: "change",
    pattern:
      /\b(?:new|changed?|updated?|different|alternative|alternate)\s+(?:bank(?:ing)?\s+(?:details|account|information|info|instructions)|account\s+(?:details|number|information)|payment\s+(?:details|information|instructions|info|address)|remittance\s+(?:details|information|instructions)|(?:wire|wiring|ach)\s+(?:instructions|information|info|details)|wallet(?:\s+address)?|(?:payout|deposit|receiving)\s+address|iban|routing\s+number|sort\s+code)\b/gi,
  },
  { kind: "change", pattern: /\b(?:our|my)\s+new\s+(?:bank|account)\b/gi },
  { kind: "change", pattern: /\b(?:changed|switched|moved|updated)\s+(?:our|my|the)\s+(?:bank|banks|banking(?:\s+details)?|account|wallet|payment\s+details)\b/gi },
  { kind: "change", pattern: /\b(?:changed|switched|moved)\s+banks?\b/gi },
  { kind: "change", pattern: /\b(?:bank(?:ing)?|account|payment|remittance|wire|ach)\s+(?:details|information|info|instructions)\s+(?:have|has)\s+(?:been\s+)?(?:changed|updated|amended)\b/gi },
  { kind: "change", pattern: /\bchange\s+(?:of|to|in)\s+(?:our\s+)?(?:bank(?:ing)?|account|payment|remittance)\s+(?:details|information|account|instructions)\b/gi },
  {
    kind: "change",
    pattern:
      /\b(?:update|amend)\s+(?:your|the)\s+(?:records|system|file|vendor\s+(?:file|record|records|master))\b|\b(?:update|amend)\s+(?:our|my|the)\s+(?:bank(?:ing)?|account|payment|remittance|vendor)\s+(?:details|information|info|record|records)\b/gi,
  },
  { kind: "change", pattern: /\b(?:do\s+not|don't|no\s+longer|please\s+stop)\s+(?:use|pay(?:\s+(?:to|into))?|send(?:\s+(?:to|it\s+to))?)\s+(?:the|our|my)\s+(?:old|previous|former|usual|current)\b/gi },
  { kind: "change", pattern: /\b(?:remit(?:\s+(?:the\s+|your\s+)?payment)?|make\s+(?:the\s+)?payment|send\s+(?:the\s+)?payment|pay)\s+(?:to|into)\s+the\s+(?:following|below|new|attached)\b|\buse\s+the\s+following\s+(?:account|bank|details)\b/gi },
  { kind: "change", pattern: /\b(?:old|previous|former)\s+account\s+(?:is|has\s+been)\s+(?:no\s+longer\s+(?:in\s+use|active|valid)|closed)\b|\bnow\s+bank(?:ing)?\s+with\b/gi },
  { kind: "pressure", pattern: /\b(?:pay|payment|paid|transfer|wire|settle|remit)\b[^.\n]{0,40}?\b(?:today|immediately|right\s+away|urgently|asap)\b/gi },
  {
    kind: "pressure",
    pattern:
      /\b(?:urgent(?:ly)?|time[-\s]sensitive|overdue|past\s+due|within\s+(?:24|48)\s+hours|by\s+(?:the\s+)?(?:end\s+of\s+(?:the\s+)?(?:day|business\s+day)|close\s+of\s+business)|before\s+\d{1,2}\s?(?:am|pm)|cob|eod|final\s+notice)\b/gi,
  },
  { kind: "no_call", pattern: /\b(?:do\s+not|don't|please\s+don't)\s+(?:call|phone|ring)\b/gi },
  { kind: "no_call", pattern: /\b(?:cannot|can't|can\s+not|unable\s+to|won't\s+be\s+able\s+to)\s+(?:take|answer|receive|make)\s+(?:any\s+)?(?:phone\s+)?calls\b/gi },
  { kind: "no_call", pattern: /\b(?:unavailable|not\s+available|unreachable|not\s+reachable)\s+(?:by|on\s+the)\s+phone\b|\bonly\s+(?:be\s+)?reachable\s+by\s+email\b/gi },
  { kind: "no_call", pattern: /\b(?:reply|respond)\s+only\s+(?:to|by)\s+(?:this\s+)?email\b|\b(?:by|via)\s+email\s+only\b/gi },
  { kind: "no_call", pattern: /\bin\s+(?:a\s+)?meetings?\s+all\s+(?:day|week)\b|\bphone\s+lines?\s+(?:is|are)\s+down\b|\bout\s+of\s+(?:the\s+)?office\b|\bon\s+a\s+flight\b|\babout\s+to\s+board\b/gi },
  {
    kind: "secrecy",
    pattern:
      /\bkeep\s+(?:this|it)\s+(?:between\s+us|quiet|private|confidential)\b|\b(?:do\s+not|don't)\s+(?:discuss|mention|share)\s+(?:this|it)\s+(?:with|to)\b|\bstrictly\s+confidential\b[^.\n]{0,40}?\b(?:between\s+us|do\s+not\s+share|do\s+not\s+discuss)\b/gi,
  },
  {
    kind: "reason",
    pattern:
      /\b(?:(?:due\s+to|because\s+of|following)\s+(?:an?\s+|our\s+|the\s+)?(?:(?:ongoing|internal|annual|year[-\s]end)\s+)?(?:audit|tax\s+(?:reasons|review|issue)|merger|acquisition|restructuring|compliance\s+review)|for\s+security\s+reasons|(?:account|bank\s+account)\s+(?:is|has\s+been|was)\s+(?:frozen|closed|suspended|on\s+hold|under\s+(?:review|maintenance)|blocked)|tax\s+reasons|audit\s+reasons)\b/gi,
  },
];

/** A header line's value, at most 320 characters: "From: Northwind <billing@northwind.com>" is "Northwind <billing@northwind.com>". */
function header(text: string, name: string): string | null {
  return text.match(new RegExp(`^[ \\t>]*${name}:[ \\t]*([^\\n]{1,320})`, "im"))?.[1] ?? null;
}

const site = (domain: string) => {
  const { name, ending } = registered(domain);
  return `${name}.${ending}`;
};

/** What the message says that a change request says (IC4). Each phrase once, in the order the message has them. */
export function readMessage(raw: string): MessageRead {
  const text = raw.slice(0, MESSAGE_MAX).replace(APOSTROPHES, "'");
  const all: Array<Cue & { at: number; end: number }> = [];
  for (const { kind, pattern } of CUES) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      all.push({ kind, phrase: match[0].replace(/\s+/g, " "), at, end: at + match[0].length });
    }
  }
  // In the message's order, longest first where two start together; a phrase overlapping one kept of its kind, or
  // the same words again, is left out: "our new bank details" is one phrase, not two.
  all.sort((a, b) => a.at - b.at || b.end - a.end);
  const found: typeof all = [];
  const seen = new Set<string>();
  for (const cue of all) {
    const key = `${cue.kind}:${cue.phrase.toLowerCase()}`;
    if (seen.has(key) || found.some((kept) => kept.kind === cue.kind && cue.at < kept.end && kept.at < cue.end)) continue;
    seen.add(key);
    found.push(cue);
  }
  const fromLine = header(text, "From");
  const replyLine = header(text, "Reply-To");
  const from = fromLine ? readEmail(fromLine) : null;
  const reply = replyLine ? readEmail(replyLine) : null;
  // An invoicing service sends from its own address and puts the vendor's in Reply-To: that is how it works, not a sign.
  const differ = from && reply && !invoiceService(from.domain) && site(from.domain) !== site(reply.domain);
  return { cues: found.map(({ kind, phrase }) => ({ kind, phrase })), from, replyTo: differ ? { from: from.domain, replyTo: reply.domain } : null };
}
