import { describe, expect, it } from "vitest";
import { groupIban, hiddenCharacter, readAccount, readBic, readIban, readRoutingCode, sameBic, samePhone } from "@/lib/invoice-check/bank";
import { callScript } from "@/lib/invoice-check/call-script";
import { compareDomains, editDistance, invoiceService, isFreeMail, readEmail, registered } from "@/lib/invoice-check/domain";
import { checkInvoice, FIELDS, type InvoiceInput } from "@/lib/invoice-check/findings";
import { readMessage } from "@/lib/invoice-check/message";
import { SAMPLE_INVOICE } from "@/lib/invoice-check/sample";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";

/**
 * The invoice details check's rules (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC3-IC7): bank details,
 * senders, the message's words, the verdict and the call script.
 */

const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const NORTHWIND = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
const UNRELATED = "0x1111111111111111111111111111111111111111";
const check = (input: Partial<InvoiceInput>) => checkInvoice({ onFile: {}, invoice: {}, message: "", ...input }, sanctioned);
const titles = (input: Partial<InvoiceInput>) => check(input).findings.map((finding) => `${finding.level}: ${finding.title}`);

describe("bank details (IC3)", () => {
  it("accepts IBANs from the registry's examples, with or without spaces, dashes and a label", () => {
    for (const iban of ["DE89370400440532013000", "GB82 WEST 1234 5698 7654 32", "FR14 2004 1010 0505 0001 3M02 606", "NL91ABNA0417164300", "CH9300762011623852957", "NO9386011117947", "BE68539007547034", "IBAN: GB82WEST12345698765432", `GB82${String.fromCharCode(0x2013)}WEST12345698765432`]) {
      expect(readIban(iban), iban).toMatchObject({ ok: true });
    }
    expect(readIban("de89 3704 0044 0532 0130 00")).toMatchObject({ ok: true, value: { iban: "DE89370400440532013000", country: "DE" } });
  });

  it("refuses an IBAN with a changed digit, the wrong length for its country, no country or a hidden character", () => {
    expect(readIban("DE89370400440532013001")).toMatchObject({ ok: false, message: expect.stringContaining("check digits") });
    expect(readIban("DE8937040044053201300")).toMatchObject({ ok: false, message: expect.stringContaining("from DE has 22 characters; this one has 21") });
    expect(readIban("89370400440532013000")).toMatchObject({ ok: false, message: expect.stringContaining("country's two letters") });
    expect(readIban(`DE89${String.fromCharCode(0x200b)}370400440532013000`)).toMatchObject({ ok: false, message: expect.stringContaining("U+200B") });
  });

  it("checks a country it has no length for by its check digits only, and says so", () => {
    // ZZ is no country: its check digits are made to pass, so only the length is unknown.
    expect(readIban("ZZ33123456789012345")).toMatchObject({ ok: true, note: "Its length is not checked for ZZ." });
  });

  it("writes an IBAN in groups of four", () => {
    expect(groupIban("GB82WEST12345698765432")).toBe("GB82 WEST 1234 5698 7654 32");
  });

  it("reads a US routing number by its check digit, a UK sort code, and any other code as written, a label taken off", () => {
    expect(readRoutingCode("021000021")).toEqual({ ok: true, value: { kind: "aba", code: "021000021" } });
    expect(readRoutingCode("ABA 021000021")).toEqual({ ok: true, value: { kind: "aba", code: "021000021" } });
    expect(readRoutingCode("021000022")).toMatchObject({ ok: false, message: expect.stringContaining("check digit") });
    expect(readRoutingCode("40 40 40")).toEqual({ ok: true, value: { kind: "sort", code: "40-40-40" } });
    expect(readRoutingCode("Sort code: 40-40-40")).toEqual({ ok: true, value: { kind: "sort", code: "40-40-40" } });
    expect(readRoutingCode("0012-345")).toEqual({ ok: true, value: { kind: "other", code: "0012345" } });
    expect(readAccount("Account no. 1234 5678")).toEqual({ ok: true, value: "12345678" });
  });

  it("reads a SWIFT / BIC code's bank and country, and takes an 8-character code as its head office", () => {
    expect(readBic("deut de ff")).toEqual({ ok: true, value: { bic: "DEUTDEFF", bank: "DEUT", country: "DE" } });
    expect(readBic("SWIFT: DEUTDEFF")).toMatchObject({ ok: true, value: { bic: "DEUTDEFF" } });
    expect(readBic("DEUTDEFF5")).toMatchObject({ ok: false });
    const head = readBic("DEUTDEFF");
    const xxx = readBic("DEUTDEFFXXX");
    const branch = readBic("DEUTDEFF500");
    if (!head.ok || !xxx.ok || !branch.ok) throw new Error("not read");
    expect(sameBic(head.value, xxx.value)).toBe(true);
    expect(sameBic(head.value, branch.value)).toBe(false);
  });

  it("takes a phone number with and without its country code as one", () => {
    expect(samePhone("+44 20 7946 0958", "020 7946 0958")).toBe(true);
    expect(samePhone("+44 20 7946 0958", "+44 20 7946 0123")).toBe(false);
    expect(samePhone("555 0100", "555-0100")).toBe(true);
  });

  it("names a hidden character by its code point", () => {
    expect(hiddenCharacter(`a${String.fromCharCode(0x202e)}b`)).toBe("U+202E");
    expect(hiddenCharacter("plain")).toBeNull();
  });
});

describe("senders (IC3)", () => {
  it("reads the sender in angle brackets, keeps another address in the name shown, and reads a bare domain", () => {
    expect(readEmail("Mara Lind <Billing@Northwind.com>")).toEqual({ address: "billing@northwind.com", domain: "northwind.com", shown: null });
    expect(readEmail(`"accounts@northwind.com" <billing@evil.io>`)).toEqual({ address: "billing@evil.io", domain: "evil.io", shown: "accounts@northwind.com" });
    expect(readEmail("northwind.com")).toEqual({ address: null, domain: "northwind.com", shown: null });
    expect(readEmail("not an email")).toBeNull();
  });

  it("reads a domain's registered name under endings of one and two labels, and on hosts anyone can have a name on", () => {
    expect(registered("billing.northwind.co.uk")).toEqual({ name: "northwind", ending: "co.uk" });
    expect(registered("northwind.com")).toEqual({ name: "northwind", ending: "com" });
    expect(registered("northwind.com.vn")).toEqual({ name: "northwind", ending: "com.vn" });
    expect(registered("northwind.onmicrosoft.com")).toEqual({ name: "northwind", ending: "onmicrosoft.com" });
  });

  it("finds the same domain, a subdomain, and every kind of lookalike", () => {
    expect(compareDomains("northwind.com", "northwind.com")).toEqual({ kind: "same" });
    expect(compareDomains("northwind.com", "billing.northwind.com")).toEqual({ kind: "same" });
    expect(compareDomains("northwind.com", "northwind.co")).toEqual({ kind: "alike", how: "ending" });
    expect(compareDomains("northwind.com", "northwind-billing.com")).toEqual({ kind: "alike", how: "added" });
    expect(compareDomains("northwind-design.com", "northwinddesign.com")).toEqual({ kind: "alike", how: "added" });
    expect(compareDomains("northwind.com", "northwind.com.evil.io")).toEqual({ kind: "alike", how: "added" });
    expect(compareDomains("northwind.com", "nothwind.com")).toEqual({ kind: "alike", how: "letters" });
    expect(compareDomains("northwind.com", "nortwhind.com")).toEqual({ kind: "alike", how: "letters" });
    expect(compareDomains("modern.com", "rnodern.com")).toEqual({ kind: "alike", how: "lookalike" });
    expect(compareDomains("northwind-design.com", "northwlnd-design.com")).toEqual({ kind: "alike", how: "lookalike" });
    expect(compareDomains("northwind.com", "xn--northwnd-5ya.com")).toEqual({ kind: "foreign" });
    expect(compareDomains("northwind.com", `northw${String.fromCharCode(0x0456)}nd.com`)).toEqual({ kind: "foreign" });
    expect(compareDomains("northwind.com", "gmail.com")).toEqual({ kind: "free" });
    expect(compareDomains("northwind.com", "harborprint.com")).toEqual({ kind: "other" });
  });

  it("never takes two names under an unlisted ending, or on a shared host, as one", () => {
    expect(compareDomains("northwind.com.vn", "attacker.com.vn")).toEqual({ kind: "other" });
    expect(compareDomains("northwind.onmicrosoft.com", "evil.onmicrosoft.com")).toEqual({ kind: "other" });
  });

  it("takes a domain and its xn-- form as one", () => {
    const unicode = `b${String.fromCharCode(0xfc)}cher.de`;
    expect(compareDomains(unicode, new URL(`http://${unicode}`).hostname)).toEqual({ kind: "same" });
  });

  it("knows free mail services and invoicing services", () => {
    expect(isFreeMail("yahoo.co.uk")).toBe(true);
    expect(isFreeMail("proton.me")).toBe(true);
    expect(isFreeMail("northwind.com")).toBe(false);
    expect(invoiceService("post.xero.com")).toBe("Xero");
    expect(invoiceService("northwind.com")).toBeNull();
  });

  it("counts a swap of two letters side by side as one edit", () => {
    expect(editDistance("northwind", "nortwhind")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
  });
});

describe("the message (IC4)", () => {
  it("finds each kind of words a change request uses, once each, in the message's order", () => {
    const read = readMessage(SAMPLE_INVOICE.message);
    expect(read.cues.map((cue) => `${cue.kind}: ${cue.phrase}`)).toEqual([
      "change: changed our bank",
      "reason: following an audit",
      "change: Our new bank",
      "change: update your records",
      "change: do not use the old",
      "pressure: overdue",
      "pressure: payment today",
      "no_call: cannot take calls",
      "no_call: reply only to this email",
    ]);
  });

  it("finds the common phrasings of a change request", () => {
    for (const sentence of [
      "Our bank details have changed.",
      "Subject: Change of bank details",
      "We have changed banks.",
      "Please update our bank details in your system.",
      "Kindly remit payment to the following account.",
      "Please use the following account for all future payments.",
      "Updated wire instructions attached.",
      "New ACH information enclosed.",
      "Our old account is no longer in use.",
      "We are now banking with another bank.",
    ]) {
      expect(readMessage(sentence).cues.map((cue) => cue.kind), sentence).toContain("change");
    }
  });

  it("finds nothing in an ordinary invoice email or a standard footer", () => {
    expect(
      readMessage(
        "Hi, please find attached invoice INV-2207 for October. Thanks for your order today. Payment is due on receipt. Please keep this invoice for tax purposes. Your new account manager is Sam. Due to the new bank holiday we close early. This email and any attachments are strictly confidential."
      ).cues
    ).toEqual([]);
  });

  it("reads curly apostrophes as straight ones", () => {
    expect(readMessage(`Please don${String.fromCharCode(0x2019)}t call, we can${String.fromCharCode(0x2019)}t take calls`).cues.map((cue) => cue.kind)).toEqual(["no_call", "no_call"]);
  });

  it("finds a Reply-To on another domain in pasted headers, and not one on the same or from an invoicing service", () => {
    expect(readMessage("From: Northwind <billing@northwind.com>\nReply-To: billing@northwind-pay.com\n\nHi").replyTo).toEqual({ from: "northwind.com", replyTo: "northwind-pay.com" });
    expect(readMessage("From: billing@northwind.com\nReply-To: ap@mail.northwind.com").replyTo).toBeNull();
    expect(readMessage("From: Xero <messaging-service@post.xero.com>\nReply-To: ap@northwind.com").replyTo).toBeNull();
  });

  it("reads a long pasted header quickly", () => {
    const started = performance.now();
    readMessage(`From: ${"a".repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("the verdict (IC3, IC5)", () => {
  it("says the example's changes as stops, its other differences as looks, and leads with the bank account", () => {
    const result = check(SAMPLE_INVOICE);
    expect(result.verdict).toBe("stop");
    expect(result.findings.map((finding) => `${finding.level}: ${finding.field}: ${finding.title}`)).toEqual([
      "stop: email: the email comes from a domain that looks like the vendor's but is not the one on file",
      "stop: iban: the bank account is not the one on file",
      "stop: wallet: the wallet address is made to look like the one on file",
      "stop: message: the message asks you to change how you pay the vendor",
      "look: phone: the phone number is not the one on file",
      "look: bic: the SWIFT / BIC code names another bank",
      "look: bank: the bank's name is not the one on file",
      "look: message: the message presses you to pay quickly",
      "look: message: the message asks you not to call",
      "look: message: the message gives a reason for new details",
    ]);
    expect(result.lead).toMatchObject({ field: "iban", level: "stop" });
    expect(result.findings.find((finding) => finding.field === "iban")?.detail).toContain("The new account is in LT; the one on file is in GB.");
    expect(result.changed).toEqual(["bank account", "wallet address"]);
    expect(result.asked).toBe(true);
    expect(result.pressure).toEqual(["pressure", "no_call"]);
    expect(result.walletPair).toMatchObject({ leading: 4, trailing: 4 });
    expect(result.fields.map((field) => field.key)).toEqual(["name", "email", "phone", "iban", "bic", "bank", "wallet"]);
    expect(result.fields.find((field) => field.key === "name")?.outcome).toBe("same");
  });

  it("is a fix when a detail on the invoice cannot be right, before any stop", () => {
    expect(check({ onFile: { iban: "GB82WEST12345698765432" }, invoice: { iban: "GB82WEST12345698765433", wallet: UNRELATED } }).findings[0]).toMatchObject({
      level: "fix",
      field: "iban",
      title: "the IBAN cannot be right as written",
    });
    expect(titles({ invoice: { routing: "021000022" } })).toEqual(["fix: the routing number cannot be right as written"]);
    expect(titles({ invoice: { wallet: "0x123" } })).toEqual(["fix: the wallet address cannot be right as written"]);
    expect(titles({ invoice: { bic: "DEUT" } })).toEqual(["fix: the SWIFT / BIC code cannot be right as written"]);
  });

  it("never lets a detail on file it cannot read hide the invoice's", () => {
    for (const [field, onFile, invoice] of [
      ["iban", "GB82 WEST 1234 5698 7654 33", "LT35 3250 0123 4567 8901"],
      ["iban", `GB82WEST12345698765432${String.fromCharCode(0x200b)}`, "LT35 3250 0123 4567 8901"],
      ["wallet", NORTHWIND.slice(0, 41), UNRELATED],
    ] as const) {
      const result = check({ onFile: { [field]: onFile }, invoice: { [field]: invoice } });
      expect(result.verdict, `${field} ${onFile}`).toBe("fix");
      expect(result.findings[0].title).toMatch(/on file cannot be read, so the invoice's was not compared$/);
      expect(result.changed.length).toBe(1);
    }
  });

  it("stops on any changed way to be paid, and on a sanctioned or special wallet", () => {
    expect(titles({ onFile: { wallet: NORTHWIND }, invoice: { wallet: UNRELATED } })).toEqual(["stop: the wallet address is not the one on file"]);
    expect(titles({ onFile: { account: "12345678" }, invoice: { account: "1234 5679" } })).toEqual(["stop: the account number is not the one on file"]);
    expect(titles({ onFile: { routing: "40-40-40" }, invoice: { routing: "20-00-00" } })).toEqual(["stop: the routing or sort code is not the one on file"]);
    expect(titles({ invoice: { wallet: sanctioned[0].address } })).toContain("stop: the wallet address is on OFAC's sanctions list");
    expect(titles({ invoice: { wallet: `0x${"0".repeat(40)}` } })).toContain("stop: the wallet address is not a wallet");
  });

  it("stops on a switch to a new way to be paid, and on the same account number at another bank", () => {
    expect(titles({ onFile: { iban: "GB82WEST12345698765432" }, invoice: { account: "12345678", routing: "021000021" } })).toEqual([
      "stop: the invoice asks you to pay a bank account that is not on file",
    ]);
    expect(titles({ onFile: { wallet: NORTHWIND }, invoice: { iban: "GB82WEST12345698765432" } })).toEqual(["stop: the invoice asks you to pay a bank account that is not on file"]);
    const bic = check({ onFile: { account: "12345678", bic: "DEUTDEFF" }, invoice: { account: "12345678", bic: "COBADEFF" } });
    expect(bic.findings.map((finding) => `${finding.level}: ${finding.title}`)).toEqual(["stop: the SWIFT / BIC code names another bank"]);
    expect(bic.changed).toEqual(["bank account"]);
  });

  it("stops on a sender's name that is another address, and on a lookalike free mail address", () => {
    expect(titles({ onFile: { email: "accounts@northwind.com" }, invoice: { email: `"accounts@northwind.com" <billing@evil.io>` } })[0]).toBe(
      "stop: the sender's name is an email address that is not the sender's"
    );
    expect(titles({ onFile: { email: "northwind.design@gmail.com" }, invoice: { email: "northwlnd.design@gmail.com" } })).toEqual([
      "stop: the email address looks like the vendor's but is not the one on file",
    ]);
    expect(titles({ onFile: { email: "acme.billing@gmail.com" }, invoice: { email: "orders.desk@gmail.com" } })).toEqual(["look: the email address is not the one on file"]);
  });

  it("compares a domain on file written alone, reads the sender from a pasted From line, and names an invoicing service", () => {
    expect(titles({ onFile: { email: "northwind.com" }, invoice: { email: "billing@northwind.co" } })).toEqual([
      "stop: the email comes from a domain that looks like the vendor's but is not the one on file",
    ]);
    const fromLine = check({ onFile: { email: "ap@northwind.com" }, message: "From: Billing <billing@northwlnd.com>\n\nHi" });
    expect(fromLine.verdict).toBe("stop");
    expect(fromLine.fields[0].note).toContain("From line");
    expect(titles({ onFile: { email: "ap@northwind.com" }, invoice: { email: "messaging-service@post.xero.com" } })).toEqual(["look: the invoice was sent through Xero"]);
  });

  it("says the same domain does not prove who sent it", () => {
    const result = check({ onFile: { email: "ap@northwind.com" }, invoice: { email: "billing@northwind.com" } });
    expect(result.verdict).toBe("nothing");
    expect(result.fields[0].note).toContain("a vendor's own mailbox can be broken into");
  });

  it("finds nothing when every detail on both sides matches as written another way", () => {
    const result = check({
      onFile: { name: "Northwind Design Ltd.", email: "ap@northwind.com", wallet: NORTHWIND, iban: "GB82 WEST 1234 5698 7654 32", routing: "404040", bic: "WESTGB2L", phone: "+44 20 7946 0958" },
      invoice: { name: "northwind design", email: "Billing <billing@northwind.com>", wallet: NORTHWIND.toUpperCase().replace("0X", "0x"), iban: "gb82west12345698765432", routing: "40-40-40", bic: "WESTGB2LXXX", phone: "020 7946 0958" },
      message: "Please find attached our invoice for October. Payment is due today.",
    });
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("nothing");
    expect(result.compared).toBe(7);
    expect(result.comparedPayment).toBe(3);
    expect(result.changed).toEqual([]);
  });

  it("compares names in any script", () => {
    const [cyrillicA, cyrillicB] = [[0x0410, 0x0411, 0x0412], [0x0413, 0x0414, 0x0415]].map((codes) => String.fromCharCode(...codes));
    expect(titles({ onFile: { name: cyrillicA }, invoice: { name: cyrillicB } })).toEqual(["look: the name is not the one on file"]);
    expect(titles({ onFile: { name: cyrillicA }, invoice: { name: cyrillicA } })).toEqual([]);
  });

  it("looks at a way to be paid on the invoice only beside one that matches, and calls it a first payment with nothing on file", () => {
    expect(titles({ onFile: { name: "Northwind", wallet: NORTHWIND }, invoice: { wallet: NORTHWIND, iban: "GB82WEST12345698765432" } })).toEqual([
      "look: a bank account that is not on file",
    ]);
    const first = check({ invoice: { name: "Northwind", iban: "GB82WEST12345698765432" } });
    expect(first.verdict).toBe("nothing");
    expect(first.onFileEmpty).toBe(true);
    expect(first.changed).toEqual([]);
  });

  it("stops on a message asking for a change even when the fields match, and says pressure only beside a change", () => {
    expect(titles({ onFile: { iban: "GB82WEST12345698765432" }, invoice: { iban: "GB82WEST12345698765432" }, message: "We have new bank details, please update your records. Urgent." })).toEqual([
      "stop: the message asks you to change how you pay the vendor",
      "look: the message presses you to pay quickly",
    ]);
    expect(titles({ onFile: { iban: "GB82WEST12345698765432" }, invoice: { iban: "GB82WEST12345698765432" }, message: "This invoice is overdue: please pay it urgently." })).toEqual([]);
  });

  it("looks at an IBAN and a BIC on the invoice from different countries", () => {
    expect(titles({ invoice: { iban: "GB82WEST12345698765432", bic: "DEUTDEFF" } })).toEqual(["look: the IBAN and the SWIFT / BIC code are in different countries"]);
  });

  it("is empty while nothing is typed", () => {
    expect(check({}).verdict).toBe("empty");
    expect(check({ onFile: { name: "   " } }).verdict).toBe("empty");
  });

  it("lists every field once, in the page's order, the wallet last", () => {
    expect(FIELDS.map((field) => field.key)).toEqual(["name", "email", "phone", "iban", "account", "routing", "bic", "bank", "wallet"]);
  });
});

describe("the call script (IC6)", () => {
  it("names the vendor, the number on file and what changed, and never a number from the invoice", () => {
    const lines = callScript({ vendor: "Northwind Design Ltd", phoneOnFile: "+44 20 7946 0958", changed: ["bank account", "wallet address"], asked: true, wallet: true });
    const text = lines.join("\n");
    expect(lines[0]).toBe("Call Northwind Design Ltd before you pay this invoice.");
    expect(lines[1]).toContain("Call +44 20 7946 0958, the number you already had.");
    expect(lines[1]).toContain("Do not use a phone number, link or email address from this invoice");
    expect(text).toContain("a new bank account and wallet address. Did you make that change?");
    expect(text).toContain("6 from the middle");
    expect(text).toContain("if one character differs, do not pay");
    expect(text).toContain("ask them to recall it");
    expect(text).toContain("Update your records only after this call.");
  });

  it("asks about a change the message asked for without naming a detail", () => {
    expect(callScript({ vendor: null, phoneOnFile: null, changed: [], asked: true, wallet: false }).join("\n")).toContain(
      "We received an email asking us to change where we pay you. Did your company send it?"
    );
  });

  it("asks to confirm the details when nothing changed, and says where to find a number when none is on file", () => {
    const lines = callScript({ vendor: null, phoneOnFile: null, changed: [], asked: false, wallet: false });
    expect(lines[0]).toBe("Call the vendor before you pay this invoice.");
    expect(lines[1]).toContain("the vendor's website typed in yourself, not one from a link or a search ad");
    expect(lines.join("\n")).toContain("can you confirm where you want to be paid?");
    expect(lines.join("\n")).toContain("If the details they read out are not the ones on this invoice, do not pay.");
    expect(lines.join("\n")).not.toContain("6 from the middle");
  });

  it("keeps a typed value on one short line", () => {
    const lines = callScript({ vendor: `Northwind\n${"x".repeat(100)}`, phoneOnFile: null, changed: [], asked: false, wallet: false });
    expect(lines[0]).not.toContain("\n");
    expect(lines[0].length).toBeLessThan(100);
  });
});
