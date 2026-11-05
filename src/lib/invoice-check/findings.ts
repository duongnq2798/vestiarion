import { chanceWords, checkAddress, sharedWords, type SanctionedEntry, type SpecialAddress } from "@/lib/address-check";
import { nameKey } from "@/lib/invoice-document/match";
import { groupIban, readAccount, readBic, readIban, readRoutingCode, sameBic, samePhone, type Bic, type Iban } from "./bank";
import { alikeNames, compareDomains, foreignLetters, invoiceService, isFreeMail, readEmail } from "./domain";
import { readMessage, type Cue, type CueKind, type MessageRead } from "./message";

/**
 * The invoice details check's rules (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC3-IC5): what the
 * public page at /check-invoice says about an invoice's payment details against the vendor's on file. Pure and run in
 * the browser, so nothing typed leaves the page.
 */

export type FieldKey = "name" | "email" | "phone" | "iban" | "account" | "routing" | "bic" | "bank" | "wallet";

export interface FieldSpec {
  key: FieldKey;
  label: string;
  /** How a finding names it: "the IBAN", "the wallet address". */
  noun: string;
  /** A way to be paid: a change to one is a stop. */
  payment: boolean;
  placeholder: { onFile: string; invoice: string };
  inputMode?: "email" | "tel";
}

/** The fields, in the page's order (IC2). */
export const FIELDS: readonly FieldSpec[] = [
  { key: "name", label: "Vendor name", noun: "the name", payment: false, placeholder: { onFile: "Northwind Design Ltd", invoice: "As the invoice writes it" } },
  {
    key: "email",
    label: "Email it came from",
    noun: "the email",
    payment: false,
    placeholder: { onFile: "accounts@northwind.com", invoice: "The sender's address, not only its name" },
    inputMode: "email",
  },
  { key: "phone", label: "Phone", noun: "the phone number", payment: false, placeholder: { onFile: "From your records", invoice: "On the invoice or email" }, inputMode: "tel" },
  { key: "iban", label: "IBAN", noun: "the IBAN", payment: true, placeholder: { onFile: "GB82 WEST 1234 …", invoice: "GB82 WEST 1234 …" } },
  { key: "account", label: "Account number", noun: "the account number", payment: true, placeholder: { onFile: "US or UK account number", invoice: "US or UK account number" } },
  {
    key: "routing",
    label: "Routing or sort code",
    noun: "the routing or sort code",
    payment: true,
    placeholder: { onFile: "US routing (9 digits) or UK sort code", invoice: "US routing (9 digits) or UK sort code" },
  },
  { key: "bic", label: "SWIFT / BIC", noun: "the SWIFT / BIC code", payment: false, placeholder: { onFile: "8 or 11 characters", invoice: "8 or 11 characters" } },
  { key: "bank", label: "Bank name", noun: "the bank's name", payment: false, placeholder: { onFile: "", invoice: "" } },
  { key: "wallet", label: "Wallet address", noun: "the wallet address", payment: true, placeholder: { onFile: "0x…, if you pay in USDC", invoice: "0x…" } },
];

export type Side = Partial<Record<FieldKey, string>>;

export interface InvoiceInput {
  onFile: Side;
  invoice: Side;
  message: string;
}

export type Level = "fix" | "stop" | "look";

export interface Finding {
  level: Level;
  field: FieldKey | "message";
  /** What was found, as a clause that follows "Do not pay yet:" or stands as a line: "the bank account is not the one on file". */
  title: string;
  /** Why it matters, in sentences. */
  detail: string;
}

export interface FieldResult {
  key: FieldKey;
  label: string;
  /** Each side as the page shows it: an IBAN in groups of four, an email as its address. */
  onFile: string | null;
  invoice: string | null;
  outcome: "same" | "differs" | "invoice_only" | "file_only" | "unread";
  /** Why a side could not be read, what was not checked, or what "same" does not prove. */
  note: string | null;
}

/** A wallet on the invoice made to look like the one on file, for the page to show digit by digit. */
export interface WalletPair {
  onFile: string;
  invoice: string;
  leading: number;
  trailing: number;
}

export interface InvoiceCheck {
  fields: FieldResult[];
  message: MessageRead | null;
  /** Fixes first, then stops, then looks; within each, in the fields' order, the message last. */
  findings: Finding[];
  /** The finding the headline names: the first of the worst level, a stop on a way to be paid before any other stop. */
  lead: Finding | null;
  /** `empty` while nothing is typed. */
  verdict: Level | "nothing" | "empty";
  /** The ways to be paid that changed, are new beside others on file, or could not be compared: "bank account". */
  changed: string[];
  /** Whether a change of payment details was asked for or found: the call script asks about it. */
  asked: boolean;
  /** Fields read on both sides. */
  compared: number;
  /** Of those, the ways to be paid. */
  comparedPayment: number;
  /** Fields typed on one side only, or on both and not read. */
  oneSided: number;
  /** Nothing typed on file at all: the page compared nothing and the call is for a first payment. */
  onFileEmpty: boolean;
  walletPair: WalletPair | null;
  /** The message pressed to hurry, asked not to be called, or asked for secrecy, beside a change: said in the headline. */
  pressure: CueKind[];
}

const LEVELS: Record<Level, number> = { fix: 0, stop: 1, look: 2 };

/** A field's text as the person typed it, or null when blank. */
const value = (side: Side, key: FieldKey) => {
  const text = side[key]?.trim() ?? "";
  return text === "" ? null : text;
};

/** Words the page quotes from what someone typed, on one line and at most 60 characters. */
function quoted(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > 60 ? `${line.slice(0, 60).trimEnd()}…` : line}”`;
}

function phrases(cues: readonly Cue[]): string {
  const shown = cues.slice(0, 3).map((cue) => quoted(cue.phrase));
  return cues.length > 3 ? `${shown.join(", ")} and ${cues.length - 3} more` : shown.join(shown.length === 2 ? " and " : ", ");
}

function specialWords(special: SpecialAddress): string {
  if (special.kind === "zero") return "It is the zero address: anything sent to it is lost.";
  if (special.kind === "burn") return "It is a burn address: anything sent to it is lost.";
  if (special.kind === "system") return "It is Arc's USDC system address, not a wallet.";
  return `It is the ${special.label} token contract, not a wallet. USDC sent to it is lost.`;
}

/** Two names as `nameKey` reads them, or, for a name with no Latin letter or digit, as written. */
function sameName(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (x !== "" && y !== "") return x === y;
  const plain = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return plain(a) === plain(b);
}

const PAYMENT_NOUN: Partial<Record<FieldKey, string>> = { wallet: "wallet address", iban: "bank account", account: "bank account", routing: "bank account" };
/** Fields whose stop the headline names first: the ways to be paid, and a SWIFT / BIC that moves an account. */
const LEAD_FIELDS = new Set<FieldKey | "message">(["wallet", "iban", "account", "routing", "bic"]);

const SAME_DOMAIN_NOTE = "The same domain does not mean the vendor sent it: a vendor's own mailbox can be broken into.";

/** What the page says about an invoice's details against the vendor's on file (IC3-IC5). */
export function checkInvoice(input: InvoiceInput, sanctioned: readonly SanctionedEntry[]): InvoiceCheck {
  const findings: Finding[] = [];
  const fields: FieldResult[] = [];
  const changed = new Set<string>();
  let walletPair: WalletPair | null = null;
  const onFileEmpty = FIELDS.every((field) => value(input.onFile, field.key) === null);
  const message = input.message.trim() === "" ? null : readMessage(input.message);
  let invoiceIban: Iban | null = null;
  let invoiceBic: Bic | null = null;
  /** Ways to be paid the invoice gives with nothing on file beside them, decided once every field is read. */
  const newOnInvoice: Array<{ key: FieldKey; noun: string }> = [];
  const noIban = value(input.onFile, "iban") === null && value(input.invoice, "iban") === null;

  const add = (level: Level, field: FieldKey | "message", title: string, detail: string) => findings.push({ level, field, title, detail });

  for (const spec of FIELDS) {
    const a = value(input.onFile, spec.key);
    let b = value(input.invoice, spec.key);
    let fromMessage = false;
    // With no sender typed, the From line of a pasted message is the sender.
    if (spec.key === "email" && b === null && message?.from) {
      b = message.from.address ?? message.from.domain;
      fromMessage = true;
    }
    if (a === null && b === null) continue;
    const result: FieldResult = { key: spec.key, label: spec.label, onFile: a, invoice: b, outcome: a === null ? "invoice_only" : b === null ? "file_only" : "same", note: null };
    if (fromMessage) result.note = "The sender is read from the From line of the message.";
    fields.push(result);
    const note = (text: string) => {
      result.note = [result.note, text].filter(Boolean).join(" ");
    };
    const differs = () => {
      result.outcome = "differs";
      if (PAYMENT_NOUN[spec.key]) changed.add(PAYMENT_NOUN[spec.key]!);
    };
    const onlyOnInvoice = () => {
      if (result.outcome === "invoice_only" && spec.payment) newOnInvoice.push({ key: spec.key, noun: PAYMENT_NOUN[spec.key]! });
    };
    /**
     * The side on file could not be read. Beside a readable side on the invoice this is a fix, never silence: a typo in
     * a record must not hide a changed account.
     */
    const unreadOnFile = (why: string) => {
      result.outcome = "unread";
      note(`The one on file was not read: ${why}`);
      if (b === null) return;
      if (PAYMENT_NOUN[spec.key]) changed.add(PAYMENT_NOUN[spec.key]!);
      add(spec.payment || spec.key === "bic" ? "fix" : "look", spec.key, `${spec.noun} on file cannot be read, so the invoice's was not compared`, `${why} Copy it again from your records: until it reads, treat the invoice's as new to you.`);
    };

    switch (spec.key) {
      case "name":
      case "bank": {
        if (a !== null && b !== null && !sameName(a, b)) {
          differs();
          add("look", spec.key, `${spec.noun} is not the one on file`, `The invoice ${spec.key === "name" ? "is from" : "names"} ${quoted(b)}; on file it is ${quoted(a)}.`);
        }
        break;
      }
      case "phone": {
        if (a !== null && b !== null && !samePhone(a, b)) {
          differs();
          add("look", "phone", "the phone number is not the one on file", "Call the number on file, not this one: a request to change payment details often gives a number that reaches whoever sent it.");
        }
        break;
      }
      case "email": {
        const known = a === null ? null : readEmail(a);
        const given = b === null ? null : readEmail(b);
        if (known) result.onFile = known.address ?? known.domain;
        if (given) result.invoice = given.address ?? given.domain;
        if (b !== null && given === null) {
          result.outcome = "unread";
          note("The invoice's was not read as an email address.");
        }
        if (a !== null && known === null) unreadOnFile("It is not an email address or a domain.");
        if (!given) break;
        if (given.shown) {
          add(
            "stop",
            "email",
            "the sender's name is an email address that is not the sender's",
            `The name shown reads ${given.shown}, but the email comes from ${given.address}. This is a common way to make an email look like it came from someone else.`
          );
        }
        const service = invoiceService(given.domain);
        if (service) {
          result.outcome = "unread";
          note(`Sent through ${service}, so not compared with the vendor's domain.`);
          add(
            "look",
            "email",
            `the invoice was sent through ${service}`,
            `Invoices sent through ${service} come from its address, not the vendor's, so the sender says nothing here. The bank details on it are whatever the account holder typed: check them as usual.`
          );
          break;
        }
        if (!known) {
          if (foreignLetters(given.domain)) {
            add("look", "email", "the email's domain is written with letters from another alphabet", `${given.domain} uses letters outside plain ASCII, or their xn-- form, which can look exactly like a domain you know.`);
          }
          break;
        }
        const match = compareDomains(known.domain, given.domain);
        if (match.kind === "same") {
          // At a free mail service the domain says nothing: anyone can open an address there.
          if (isFreeMail(given.domain) && known.address && given.address && known.address !== given.address) {
            differs();
            const local = (address: string) => address.slice(0, address.lastIndexOf("@"));
            if (alikeNames(local(known.address), local(given.address))) {
              add("stop", "email", "the email address looks like the vendor's but is not the one on file", `${given.address} reads like ${known.address}. Anyone can open an address at ${given.domain} that looks like the vendor's.`);
            } else {
              add("look", "email", "the email address is not the one on file", `${given.address} is not ${known.address}, and anyone can open an address at ${given.domain}.`);
            }
          } else {
            note(SAME_DOMAIN_NOTE);
          }
          break;
        }
        differs();
        if (match.kind === "alike") {
          const how = {
            ending: `${given.domain} has the vendor's name under another ending than ${known.domain}.`,
            added: `${given.domain} is the vendor's name with something added or taken away; on file it is ${known.domain}.`,
            letters: `${given.domain} differs from ${known.domain} by a letter or two.`,
            lookalike: `${given.domain} reads like ${known.domain}, with letters that look alike.`,
          }[match.how];
          add(
            "stop",
            "email",
            "the email comes from a domain that looks like the vendor's but is not the one on file",
            `${how} Anyone can register such a domain and send invoices that look like the vendor's.`
          );
        } else if (match.kind === "foreign") {
          add("stop", "email", "the email's domain is written with letters from another alphabet", `${given.domain} uses letters outside plain ASCII, or their xn-- form, which can look exactly like ${known.domain}.`);
        } else if (match.kind === "free") {
          add("look", "email", "the email comes from a free mail address", `${given.domain} is a free mail service anyone can open an address with; the vendor's on file is at ${known.domain}.`);
        } else {
          add("look", "email", "the email comes from another domain", `${given.domain} is not ${known.domain}, the vendor's domain on file.`);
        }
        break;
      }
      case "wallet": {
        const known = a === null ? null : checkAddress(a, [], []);
        const knownAddress = known?.address ?? null;
        if (known?.checksummed) result.onFile = known.checksummed;
        if (b !== null) {
          const given = checkAddress(b, knownAddress ? [{ label: "on file", address: knownAddress }] : [], sanctioned);
          if (!given.format.ok || !given.address) {
            add("fix", "wallet", "the wallet address cannot be right as written", given.format.ok ? "It is not an address." : given.format.message);
            result.outcome = "unread";
            break;
          }
          result.invoice = given.checksummed;
          if (given.sanctioned) add("stop", "wallet", "the wallet address is on OFAC's sanctions list", `OFAC lists it under ${given.sanctioned.name}.`);
          if (given.special) add("stop", "wallet", "the wallet address is not a wallet", specialWords(given.special));
          if (given.checksum === "invalid") {
            add("stop", "wallet", "the wallet address's checksum does not match", "Its mix of capitals does not match its EIP-55 checksum, so a character was mistyped or changed.");
          }
          if (knownAddress) {
            const match = given.matches[0];
            if (match?.kind !== "same") {
              differs();
              if (match?.kind === "alike") {
                walletPair = { onFile: knownAddress, invoice: given.address, leading: match.leading, trailing: match.trailing };
                add(
                  "stop",
                  "wallet",
                  "the wallet address is made to look like the one on file",
                  `It shares ${sharedWords(match)} with the address on file and differs in between. A random address does that about once in ${chanceWords(match.leading + match.trailing)}: this is how address poisoning works.`
                );
              } else {
                add("stop", "wallet", "the wallet address is not the one on file", "A new wallet is a change of payment details. Confirm it on a call before you pay to it.");
              }
            }
          }
        }
        if (known && !known.format.ok) unreadOnFile(known.format.message);
        onlyOnInvoice();
        break;
      }
      case "iban": {
        const known = a === null ? null : readIban(a);
        if (known?.ok) result.onFile = groupIban(known.value.iban);
        if (b !== null) {
          const given = readIban(b);
          if (!given.ok) {
            add("fix", "iban", "the IBAN cannot be right as written", given.message);
            result.outcome = "unread";
            break;
          }
          invoiceIban = given.value;
          result.invoice = groupIban(given.value.iban);
          if (given.note) note(given.note);
          if (known?.ok && known.value.iban !== given.value.iban) {
            differs();
            const country = known.value.country === given.value.country ? "" : ` The new account is in ${given.value.country}; the one on file is in ${known.value.country}.`;
            add("stop", "iban", "the bank account is not the one on file", `The invoice asks you to pay ${groupIban(given.value.iban)}; on file it is ${groupIban(known.value.iban)}.${country}`);
          }
        }
        if (known && !known.ok) unreadOnFile(known.message);
        onlyOnInvoice();
        break;
      }
      case "account": {
        const known = a === null ? null : readAccount(a);
        if (known?.ok) result.onFile = known.value;
        if (b !== null) {
          const given = readAccount(b);
          if (!given.ok) {
            add("fix", "account", "the account number cannot be right as written", given.message);
            result.outcome = "unread";
            break;
          }
          result.invoice = given.value;
          if (known?.ok && known.value !== given.value) {
            differs();
            add("stop", "account", "the account number is not the one on file", `The invoice asks you to pay account ${given.value}; on file it is ${known.value}.`);
          }
        }
        if (known && !known.ok) unreadOnFile(known.message);
        onlyOnInvoice();
        break;
      }
      case "routing": {
        const known = a === null ? null : readRoutingCode(a);
        if (known?.ok) result.onFile = known.value.code;
        if (b !== null) {
          const given = readRoutingCode(b);
          if (!given.ok) {
            add("fix", "routing", "the routing number cannot be right as written", given.message);
            result.outcome = "unread";
            break;
          }
          result.invoice = given.value.code;
          if (given.value.kind === "sort") note("A sort code has no check digit, so only its form is read.");
          if (known?.ok && known.value.code !== given.value.code) {
            differs();
            add("stop", "routing", "the routing or sort code is not the one on file", `The invoice gives ${given.value.code}; on file it is ${known.value.code}. A new code means another bank, or another branch.`);
          }
        }
        if (known && !known.ok) unreadOnFile(known.message);
        onlyOnInvoice();
        break;
      }
      case "bic": {
        const known = a === null ? null : readBic(a);
        if (known?.ok) result.onFile = known.value.bic;
        if (b !== null) {
          const given = readBic(b);
          if (!given.ok) {
            add("fix", "bic", "the SWIFT / BIC code cannot be right as written", given.message);
            result.outcome = "unread";
            break;
          }
          invoiceBic = given.value;
          result.invoice = given.value.bic;
          if (known?.ok && !sameBic(known.value, given.value)) {
            differs();
            const country = known.value.country === given.value.country ? "" : ` The bank is in ${given.value.country} now, not ${known.value.country}.`;
            const title = given.value.bank === known.value.bank ? "the SWIFT / BIC code names another branch" : "the SWIFT / BIC code names another bank";
            // With no IBAN, the same account number at another bank is another account.
            if (noIban) changed.add("bank account");
            add(noIban ? "stop" : "look", "bic", title, `The invoice gives ${given.value.bic}; on file it is ${known.value.bic}.${country}${noIban ? " The same account number at another bank is another account." : ""}`);
          }
        }
        if (known && !known.ok) unreadOnFile(known.message);
        break;
      }
    }
  }

  // A way to be paid on the invoice only. Beside others on file that none of the invoice's matches, it is a switch to a
  // new way to be paid, a stop; beside one that matches, a look; with nothing on file at all, a first payment.
  if (!onFileEmpty && newOnInvoice.length > 0) {
    const paymentOnFile = fields.some((field) => FIELDS.find((spec) => spec.key === field.key)!.payment && field.onFile !== null);
    const paymentSame = fields.some((field) => FIELDS.find((spec) => spec.key === field.key)!.payment && field.outcome === "same");
    const level: Level = paymentOnFile && !paymentSame ? "stop" : "look";
    // An account number and its routing code are one bank account: said once.
    const said = new Set<string>();
    for (const { key, noun } of newOnInvoice) {
      changed.add(noun);
      if (said.has(noun)) continue;
      said.add(noun);
      add(
        level,
        key,
        level === "stop" ? `the invoice asks you to pay a ${noun} that is not on file` : `a ${noun} that is not on file`,
        level === "stop"
          ? "None of the ways to be paid on file is on the invoice: it asks you to pay somewhere new. Confirm it on a call before you pay to it."
          : "The invoice gives a way to be paid that you have no record of. Confirm it on a call before you pay to it."
      );
    }
  }

  if (invoiceIban && invoiceBic && invoiceIban.country !== invoiceBic.country) {
    add(
      "look",
      "bic",
      "the IBAN and the SWIFT / BIC code are in different countries",
      `The IBAN is from ${invoiceIban.country}, the SWIFT / BIC code from ${invoiceBic.country}. An account is usually held at a bank in its own country: ask about it on the call.`
    );
  }

  const pressure: CueKind[] = [];
  let changeAsked = false;
  if (message) {
    const of = (kind: CueKind) => message.cues.filter((cue) => cue.kind === kind);
    const change = of("change");
    changeAsked = change.length > 0;
    if (changeAsked) {
      add(
        "stop",
        "message",
        "the message asks you to change how you pay the vendor",
        `It says ${phrases(change)}. A request like this is checked on a call to a number you already had, even when the details above match: if someone updated your records from an earlier email, the details on file may be the new ones too.`
      );
    }
    // Pressure and the rest are said only beside a change: alone, "today" or "overdue" is an ordinary invoice.
    const besideChange = changeAsked || changed.size > 0 || findings.some((finding) => finding.level === "stop");
    if (besideChange) {
      const looks: Array<[CueKind, string, string]> = [
        ["pressure", "the message presses you to pay quickly", "Hurry is how a change request gets paid before anyone calls."],
        ["no_call", "the message asks you not to call", "A vendor who changed banks can take a call about it. Call the number on file anyway."],
        ["secrecy", "the message asks you to keep it quiet", "A vendor has no reason to keep its own bank details a secret from your team."],
        ["reason", "the message gives a reason for new details", "An audit, a security review or a frozen account is the reason such requests usually give."],
      ];
      for (const [kind, title, why] of looks) {
        const cues = of(kind);
        if (cues.length === 0) continue;
        add("look", "message", title, `It says ${phrases(cues)}. ${why}`);
        if (kind !== "reason") pressure.push(kind);
      }
    }
    if (message.replyTo) {
      add("look", "message", "a reply would go to another domain", `The message is from ${message.replyTo.from}, but a reply to it goes to ${message.replyTo.replyTo}.`);
    }
  }

  const order = (finding: Finding) => (finding.field === "message" ? FIELDS.length : FIELDS.findIndex((field) => field.key === finding.field));
  findings.sort((x, y) => LEVELS[x.level] - LEVELS[y.level] || order(x) - order(y));
  const typed = fields.length > 0 || message !== null;
  const verdict: InvoiceCheck["verdict"] = findings[0]?.level ?? (typed ? "nothing" : "empty");
  const lead = verdict === "stop" ? (findings.find((finding) => finding.level === "stop" && LEAD_FIELDS.has(finding.field)) ?? findings[0]) : (findings[0] ?? null);
  const both = fields.filter((field) => field.onFile !== null && field.invoice !== null && field.outcome !== "unread");
  const comparedPayment = both.filter((field) => FIELDS.find((spec) => spec.key === field.key)!.payment).length;
  const oneSided = fields.length - both.length;
  const asked = changed.size > 0 || changeAsked;
  return { fields, message, findings, lead, verdict, changed: [...changed], asked, compared: both.length, comparedPayment, oneSided, onFileEmpty, walletPair, pressure };
}

