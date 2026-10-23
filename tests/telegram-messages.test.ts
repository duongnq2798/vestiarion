import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import { NEVER_APPROVES as DISCORD_NEVER_APPROVES } from "@/lib/discord/messages";
import type { InvoiceDraftRead } from "@/lib/invoice-document/draft";
import { buildWaitingNotice, type NoticePolicy, type WaitingBill } from "@/lib/notifications/waiting-notice";
import {
  BOT_COMMANDS, decisionsMessage, draftMessage, helpMessage, ledgerMessage, MESSAGE_MAX, missingMessage, NEVER_APPROVES, plainText, telegramText,
} from "@/lib/telegram/messages";

/**
 * What the bot says (Telegram bot design R8–R12): HTML in which every value is escaped, links that are absolute and
 * stay inside the workspace, and messages that never pass Telegram's length limit, so Telegram never refuses one.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const WORKSPACE = { name: "Acme & Sons", slug: "acme" };
const TX = `0x${"ab".repeat(32)}`;

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  const base = {
    seq: 41,
    text: "Paid Centronex 0.35 USDC · 26 s after it was added",
    detail: "DeepSeek decided, as the written policy would.",
    tone: "done",
    path: "/invoices#invoice-1",
    pathLabel: "See it on Bills & receivables",
    txHash: TX,
    network: "arc-testnet",
    ...overrides,
  } as ActivityItem;
  return { ...base, txUrl: overrides.txUrl !== undefined ? overrides.txUrl : base.txHash ? `https://explorer.testnet.arc.io/tx/${base.txHash}` : null };
}

describe("decisionsMessage", () => {
  it("escapes every value, in names and in reasons", () => {
    const message = decisionsMessage(
      { name: "A&B <Ltd>", slug: "acme" },
      [item({ text: "Held A&B <Ltd> 3.00 USDC", detail: "Limit <2> & over", tone: "stopped" })],
      ORIGIN
    );
    expect(message).toContain("A&amp;B &lt;Ltd&gt;");
    expect(message).toContain("Limit &lt;2&gt; &amp; over");
    expect(message).not.toContain("<Ltd>");
  });

  it("names the network on a transaction's link: Arc mainnet for a workspace there (mainnet copy C1)", () => {
    const message = decisionsMessage({ name: "Acme", slug: "acme" }, [item({ network: "arc-mainnet", txUrl: `https://explorer.arc.io/tx/${TX}` })], "https://www.vestiarion.xyz");
    expect(message).toContain(`<a href="https://explorer.arc.io/tx/${TX}">Arc mainnet transaction</a>`);
    expect(message).not.toContain("Arc testnet");
  });

  it("links the transaction on Arc testnet only when there is one, and the page under the workspace", () => {
    const paid = decisionsMessage(WORKSPACE, [item()], ORIGIN);
    expect(paid).toContain(`<a href="https://explorer.testnet.arc.io/tx/${TX}">Arc testnet transaction</a>`);
    expect(paid).toContain('<a href="https://www.vestiarion.xyz/o/acme/invoices#invoice-1">See it on Bills &amp; receivables</a>');

    const held = decisionsMessage(WORKSPACE, [item({ txHash: null, tone: "stopped", path: "/approvals#payable-9", pathLabel: "Decide in Approvals" })], ORIGIN);
    expect(held).not.toContain("/tx/");
    expect(held).toContain('<a href="https://www.vestiarion.xyz/o/acme/approvals#payable-9">Decide in Approvals</a>');
  });

  it("marks what was done apart from what was stopped", () => {
    const message = decisionsMessage(WORKSPACE, [item(), item({ seq: 42, tone: "stopped", text: "Held Jiren 3.00 USDC" })], ORIGIN);
    expect(message).toContain("✅ Paid Centronex");
    expect(message).toContain("⏸ Held Jiren");
  });

  it("gives a payment Circle has not confirmed no check mark: it is submitted, not done (I17)", () => {
    const text = "Submitted 0.30 USDC to Jiren; waiting for Circle to confirm it on Arc testnet.";
    const message = decisionsMessage(WORKSPACE, [item({ seq: 43, tone: "pending", text })], ORIGIN);
    expect(message).toContain(`\n\n${text}`);
    expect(message).not.toContain("✅");
    expect(message).not.toContain("⏸");
  });

  it("stays under Telegram's limit with many long decisions, and says how many more the console holds", () => {
    const long = "x".repeat(600);
    const items = Array.from({ length: 40 }, (_, index) => item({ seq: index + 1, text: `Paid vendor ${index} ${long}`, detail: long }));
    const message = decisionsMessage(WORKSPACE, items, ORIGIN);

    expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    const shown = (message.match(/✅/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(40);
    expect(message).toContain(`and ${40 - shown} more`);
    expect(message).toContain('href="https://www.vestiarion.xyz/o/acme/console"');
  });
});

describe("plainText", () => {
  it("turns a message back into the words it shows, for a send without formatting", () => {
    const message = decisionsMessage({ name: "A&B <Ltd>", slug: "acme" }, [item({ txHash: null })], ORIGIN);
    const plain = plainText(message);
    expect(plain).toContain("A&B <Ltd>");
    expect(plain).not.toMatch(/<\/?(b|i|a)\b/);
    expect(plain).not.toContain("&amp;");
  });
});

const READ: InvoiceDraftRead = {
  draft: {
    vendorName: "Northwind Hosting",
    invoiceNumber: "INV-2207",
    amount: "200.00",
    currency: "USDC",
    dueDate: "2026-10-31",
    poReference: "PO-1042",
    earlyPayDiscountPct: "2",
    discountDeadline: "2026-10-11",
    payToAddress: null,
    memo: "Hosting <October>",
    counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de",
  },
  counterpartyName: "Northwind Hosting",
  warnings: ["The total line reads 210.00, but the model read 200.00. Check the amount against the invoice."],
  notFound: [],
  modelNote: "The due date is printed twice.",
  reader: "deepseek",
  document: { kind: "pdf", sha256: "a".repeat(64), truncated: false },
};

describe("draftMessage", () => {
  it("shows every field read, the warnings, and the model's note as the model's", () => {
    const message = draftMessage(READ);
    expect(message).toContain("Northwind Hosting");
    expect(message).toContain("200.00 USDC");
    expect(message).toContain("2026-10-31");
    expect(message).toContain("PO-1042");
    expect(message).toContain("2% if paid by 2026-10-11");
    expect(message).toContain("Hosting &lt;October&gt;");
    expect(message).toContain("The total line reads 210.00");
    expect(message).toContain("The model's note: The due date is printed twice.");
  });

  it("says when there is no purchase order, because the agent asks for one", () => {
    expect(draftMessage({ ...READ, draft: { ...READ.draft, poReference: null } })).toContain("Purchase order: none");
  });
});

describe("missingMessage", () => {
  it("names what is missing and links the workspace's invoices", () => {
    const message = missingMessage(READ, ["no counterparty in this workspace matches “Quill & Co”", "no due date"], `${ORIGIN}/o/acme/invoices`);
    expect(message).toContain("no counterparty in this workspace matches “Quill &amp; Co”");
    expect(message).toContain("no due date");
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/invoices">Bills &amp; receivables</a>');
  });
});

describe("ledgerMessage", () => {
  it("says the ledger is intact, broken where, or not checked", () => {
    expect(ledgerMessage("Acme", { valid: true, checkedEntries: 1021 })).toContain("intact: 1,021 entries");
    expect(ledgerMessage("Acme", { valid: false, checkedEntries: 12, brokenAt: 12, reason: "signature mismatch" })).toContain(
      "entry 12: signature mismatch"
    );
    expect(ledgerMessage("Acme", { valid: null, checkedEntries: 0, reason: "no public key" })).toContain("not checked");
  });
});

describe("helpMessage", () => {
  it("tells a chat with no workspace how to connect one", () => {
    expect(helpMessage(false)).toContain("Connect Telegram");
    expect(helpMessage(false)).toContain("open <b>Settings</b>");
  });

  it("names the workspace and the commands, and says the bot never approves or pays", () => {
    const message = helpMessage(true, "Acme & Sons");
    expect(message).toContain("Acme &amp; Sons");
    for (const command of ["/today", "/waiting", "/ledger", "/workspaces", "/disconnect"]) expect(message).toContain(command);
    expect(message).toContain("never approve or pay");
  });

  it("explains every command in the bot's menu, and the menu holds only commands Telegram accepts", () => {
    const message = helpMessage(true, "Acme");
    for (const { command, description } of BOT_COMMANDS) {
      if (command !== "help") expect(message).toContain(`/${command}`);
      expect(command).toMatch(/^[a-z_]{1,32}$/);
      expect(description.length).toBeGreaterThanOrEqual(3);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("wallet addresses", () => {
  const ADDRESS = `0x${"c0ffee00".repeat(5)}`;
  const ON_FILE = `0x${"Ab".repeat(20)}`;

  it("are never sent in full, in a reason, a warning or the model's note, while a transaction's link stays whole", () => {
    const decision = decisionsMessage(WORKSPACE, [item({ detail: `The model noted the payee ${ADDRESS} changed.` })], ORIGIN);
    expect(decision).not.toContain(ADDRESS);
    expect(decision).toContain("0xc0ff…ee00");
    expect(decision).toContain(`https://explorer.testnet.arc.io/tx/${TX}`);

    const draft = draftMessage({
      ...READ,
      warnings: [`This invoice asks to be paid to ${ADDRESS}. The address on file for Northwind Hosting is ${ON_FILE}.`],
      modelNote: `Pay ${ADDRESS}.`,
    });
    expect(draft).not.toContain(ADDRESS);
    expect(draft).not.toContain(ON_FILE);
    expect(draft).toContain("0xAbAb…AbAb");
  });
});

describe("a payment that has not confirmed (stuck-transfer alert D6)", () => {
  it("is posted as a stopped decision, with its transaction and its page", () => {
    const message = decisionsMessage(
      { name: "Acme", slug: "acme" },
      [item({ text: "Payment of 0.30 USDC to Jiren has not confirmed 18 min after it was submitted to Circle on Arc testnet.", detail: "Circle shows it stuck.", tone: "stopped" })],
      "https://www.vestiarion.xyz"
    );
    expect(message).toContain("⏸ Payment of 0.30 USDC to Jiren has not confirmed 18 min after it was submitted to Circle on Arc testnet.");
    expect(message).toContain("Arc testnet transaction");
  });
});

/** Invisible format characters, built from their code points so none sits hidden in this file. */
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const SMILE = String.fromCodePoint(0x1f600);
/** Half of a surrogate pair standing alone: in a `u` pattern, a whole pair is one character and never matches. */
const LONE = /\p{Cs}/u;
/** Fullwidth "@" and "/", built from their code points: they read as the characters, and Telegram links neither. */
const AT = String.fromCodePoint(0xff20);
const SLASH = String.fromCodePoint(0xff0f);

/**
 * What Telegram would make tappable in a message's text, roughly as it finds them in every message a bot sends: a web
 * address (a dot before a domain's ending, or a scheme's `://`), an @name and a /command. The message's own links, its
 * `<a>` tags, are left out, and so is a closing tag's slash.
 */
function autoLinks(message: string): string[] {
  const text = message.replace(/<a href="[^"]*">[^<]*<\/a>/g, "");
  return [...text.matchAll(/[\p{L}\p{N}-]\.\p{L}{2}|:\/\/|(?<![\p{L}\p{N}_])@\w|(?<![\p{L}\p{N}_/<>\\])\/\w/gu)].map((match) => match[0]);
}

describe("telegramText (docs/superpowers/specs/2026-10-23-telegram-review-links-design.md TG4)", () => {
  it("removes invisible format characters, as Discord's messages do", () => {
    expect(telegramText(`${RLO}Jir${ZWSP}en`)).toBe("Jiren");
  });

  it("escapes Telegram's HTML, and puts each value on one line", () => {
    expect(telegramText('A&B <Ltd> "x"')).toBe("A&amp;B &lt;Ltd&gt; &quot;x&quot;");
    expect(telegramText("Line one\n\tline two ")).toBe("Line one line two");
  });

  it("clips by UTF-16 units, never between the two halves of an emoji, and never inside an escape", () => {
    const cut = telegramText(`ab${SMILE}cdef`, 4);
    expect(cut).toBe("ab…");
    expect(cut).not.toMatch(LONE);
    expect(telegramText(`ab${SMILE}`, 4)).toBe(`ab${SMILE}`);
    expect(telegramText("A&B".repeat(10), 10)).toBe("A&amp;BA&amp;BA&amp;B…");
  });

  it("drops half of an emoji the value already carried", () => {
    expect(telegramText(`${String.fromCharCode(0xd83d)}Jiren`)).toBe("Jiren");
  });

  it("shortens a wallet address before it clips, so no cut leaves most of one", () => {
    const address = `0x${"c0ffee00".repeat(5)}`;
    expect(telegramText(`Pay ${address} now`)).toBe("Pay 0xc0ff…ee00 now");
    expect(telegramText(`Pay ${address}`, 20)).toBe("Pay 0xc0ff…ee00");
  });

  it("breaks up what Telegram would make a link of: a web address, an @name, a /command, an email", () => {
    expect(telegramText("Acme https://vestiarion-approvals.example/o/acme/approvals")).toBe(
      `Acme https:${SLASH}${SLASH}vestiarion-approvals[.]example/o/acme/approvals`
    );
    expect(telegramText("Booking.com")).toBe("Booking[.]com");
    expect(telegramText("Acme t.me/evil_bot")).toBe("Acme t[.]me/evil_bot");
    expect(telegramText("Acme @vestiarion_support")).toBe(`Acme ${AT}vestiarion_support`);
    expect(telegramText("Acme /disconnect")).toBe(`Acme ${SLASH}disconnect`);
    expect(telegramText("(/disconnect@vestiarion_bot)")).toBe(`(${SLASH}disconnect${AT}vestiarion_bot)`);
    expect(telegramText("Write to billing@acme.co.uk")).toBe(`Write to billing${AT}acme[.]co[.]uk`);
    expect(telegramText("tg://resolve?domain=evil_bot")).toBe(`tg:${SLASH}${SLASH}resolve?domain=evil_bot`);
    expect(telegramText("Pay at 203.0.113.5/login")).toBe("Pay at 203[.]0[.]113[.]5/login");
    for (const value of ["Acme https://pay.acme-billing.com", "Acme @vestiarion_support", "Acme /disconnect", "billing@acme.com"]) {
      expect(autoLinks(telegramText(value)), value).toEqual([]);
    }
  });

  it("leaves amounts, fractions and abbreviations as they read", () => {
    expect(telegramText("Over the 2.00 USDC limit, e.g. 1/3 of it, N/A for U.S. vendors.")).toBe("Over the 2.00 USDC limit, e.g. 1/3 of it, N/A for U.S. vendors.");
  });
});

describe("a decision's own words (docs/superpowers/specs/2026-10-23-telegram-review-links-design.md TG4)", () => {
  it("are plain text, as the bills' are: no hidden characters, one line each, and no link, @name or /command of their own", () => {
    const message = decisionsMessage(
      { name: `Acme${RLO} Ltd`, slug: "acme" },
      [item({ text: `Paid ${RLO}Acme https://pay.acme-billing.com 0.35 USDC`, detail: `Ask @acme_billing,\nor send /disconnect.${ZWSP}` })],
      ORIGIN
    );
    expect(message).not.toContain(RLO);
    expect(message).not.toContain(ZWSP);
    expect(autoLinks(message)).toEqual([]);
    expect(message.split("\n")).toEqual([
      "<b>Acme Ltd</b> · the agent decided 1 thing",
      "",
      `✅ Paid Acme https:${SLASH}${SLASH}pay[.]acme-billing[.]com 0.35 USDC`,
      `<i>Ask ${AT}acme_billing, or send ${SLASH}disconnect.</i>`,
      `<a href="https://explorer.testnet.arc.io/tx/${TX}">Arc testnet transaction</a> · <a href="${ORIGIN}/o/acme/invoices#invoice-1">See it on Bills &amp; receivables</a>`,
    ]);
  });
});

const BILL = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const REASONING = "The invoice has no purchase order. It waits for a person.";
const bill = (n: number, fields: Partial<WaitingBill> = {}): WaitingBill => ({
  id: BILL(n), payee: `Vendor ${n}`, amount: 120, currency: "USDC", status: "held", reasoning: REASONING, ...fields,
});
/** What the activity says of a payable the agent stopped: the model's own first sentence, and Decide in Approvals. */
const stopped = (n: number, fields: Partial<ActivityItem> = {}) =>
  item({
    seq: 50 + n, tone: "stopped", text: `Held Vendor ${n} 120.00 USDC for you.`, detail: "The model's own words on it.", txHash: null,
    path: `/approvals#payable-${BILL(n)}`, pathLabel: "Decide in Approvals", invoiceId: BILL(n), ...fields,
  });
const waiting = (bills: WaitingBill[], policy?: NoticePolicy) => ({ notice: buildWaitingNotice(bills, policy), invoiceIds: new Set(bills.map((one) => one.id)) });
const review = (n: number) => `<a href="${ORIGIN}/o/acme/approvals#payable-${BILL(n)}">Review</a>`;
const ACME = { name: "Acme", slug: "acme" };

describe("the bills waiting for approval, in the decisions message (TG2)", () => {
  it("lists the bills still waiting in one section, in place of their blocks, each with a Review link to its card", () => {
    const message = decisionsMessage(
      ACME,
      [item(), stopped(1), stopped(2), stopped(3)],
      ORIGIN,
      waiting([bill(1), bill(2, { status: "flagged", currency: "EURC", amount: 75.5 }), bill(3, { status: "awaiting_info" })])
    );
    expect(message.split("\n")).toEqual([
      "<b>Acme</b> · the agent decided 4 things",
      "",
      "✅ Paid Centronex 0.35 USDC · 26 s after it was added",
      "<i>DeepSeek decided, as the written policy would.</i>",
      `<a href="https://explorer.testnet.arc.io/tx/${TX}">Arc testnet transaction</a> · <a href="${ORIGIN}/o/acme/invoices#invoice-1">See it on Bills &amp; receivables</a>`,
      "",
      "3 bills wait for approval:",
      `⏸ <b>120.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · ${review(1)}`,
      `⏸ <b>75.50 EURC</b> · Vendor 2 · flagged: The invoice has no purchase order. · ${review(2)}`,
      `⏸ <b>120.00 USDC</b> · Vendor 3 · waiting for details: The invoice has no purchase order. · ${review(3)}`,
      "Opening a link never approves anything.",
    ]);
    expect(message).not.toContain("Decide in Approvals");
    expect(message).not.toContain("The model's own words on it.");
  });

  it("lists a bill stopped twice once, and keeps the block of one a person decided since", () => {
    const message = decisionsMessage(ACME, [stopped(1), stopped(4), stopped(1, { seq: 60 })], ORIGIN, waiting([bill(1)]));
    expect(message).toContain("<b>Acme</b> · the agent decided 3 things");
    expect(message).toContain("1 bill waits for approval:");
    expect(message.match(/Vendor 1/g)).toHaveLength(1);
    // Vendor 4's bill no longer waits: its decision is told as it was made.
    expect(message).toContain(`⏸ Held Vendor 4 120.00 USDC for you.\n<i>The model's own words on it.</i>\n<a href="${ORIGIN}/o/acme/approvals#payable-${BILL(4)}">Decide in Approvals</a>`);
  });

  it("keeps a shadow-mode verdict hold in its own block, with Give your verdict", () => {
    const verdict = stopped(5, { text: "Decided to pay Vendor 5 120.00 USDC; it waits for your verdict in shadow mode.", pathLabel: "Give your verdict", invoiceId: undefined });
    const message = decisionsMessage(ACME, [verdict, stopped(1)], ORIGIN, waiting([bill(1)]));
    expect(message).toContain(`<a href="${ORIGIN}/o/acme/approvals#payable-${BILL(5)}">Give your verdict</a>`);
    expect(message).toContain(`⏸ <b>120.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · ${review(1)}`);
  });

  it("says a bill above the figure needs two approvals, and that an accountant can co-sign while co-signing is on", () => {
    const bills = [bill(1, { amount: 900 }), bill(2, { amount: 20 })];
    const off = decisionsMessage(ACME, [stopped(1), stopped(2)], ORIGIN, waiting(bills, { twoApprovalsAbove: 500, accountantCosigns: false })).split("\n");
    expect(off).toContain(`⏸ <b>900.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · needs two approvals · ${review(1)}`);
    expect(off).toContain(`⏸ <b>20.00 USDC</b> · Vendor 2 · held: The invoice has no purchase order. · ${review(2)}`);

    const on = decisionsMessage(ACME, [stopped(1), stopped(2)], ORIGIN, waiting(bills, { twoApprovalsAbove: 500, accountantCosigns: true })).split("\n");
    expect(on).toContain(`⏸ <b>900.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · needs two approvals, an accountant can co-sign · ${review(1)}`);
    expect(on).toContain(`⏸ <b>20.00 USDC</b> · Vendor 2 · held: The invoice has no purchase order. · ${review(2)}`);
  });

  it("says the bill's status alone when the agent gave no reason", () => {
    const message = decisionsMessage(ACME, [stopped(1)], ORIGIN, waiting([bill(1, { reasoning: null, status: "awaiting_info" })]));
    expect(message).toContain(`⏸ <b>120.00 USDC</b> · Vendor 1 · waiting for details · ${review(1)}`);
  });

  it("links each card on Approvals with no token, and says once that opening a link approves nothing, as Discord says it", () => {
    const message = decisionsMessage(ACME, [stopped(1), stopped(2)], ORIGIN, waiting([bill(1), bill(2)]));
    const hrefs = [...message.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([`${ORIGIN}/o/acme/approvals#payable-${BILL(1)}`, `${ORIGIN}/o/acme/approvals#payable-${BILL(2)}`]);
    for (const href of hrefs) expect(href).not.toMatch(/token=|vx1\./);
    expect(NEVER_APPROVES).toBe(DISCORD_NEVER_APPROVES);
    expect(message.split(NEVER_APPROVES)).toHaveLength(2);
    expect(message.endsWith(`\n${NEVER_APPROVES}`)).toBe(true);
  });

  it("shows a payee's name and the reason as plain text: escaped, without hidden direction or zero-width characters", () => {
    const message = decisionsMessage(
      ACME,
      [stopped(1)],
      ORIGIN,
      waiting([bill(1, { payee: `A&B ${RLO}<Ltd>`, reasoning: `Over the <b>limit</b> for Ac${ZWSP}me.` })])
    );
    // The closing tag's slash, which follows no letter, reads in its fullwidth form, as any such slash does.
    expect(message).toContain(`· A&amp;B &lt;Ltd&gt; · held: Over the &lt;b&gt;limit&lt;${SLASH}b&gt; for Acme. ·`);
    expect(message).not.toContain(RLO);
    expect(message).not.toContain(ZWSP);
  });

  it("gives Telegram no link, @name or /command to make of a payee's name or a reason: the only links are Vestiarion's", () => {
    const message = decisionsMessage(
      ACME,
      [stopped(1), stopped(2), stopped(3)],
      ORIGIN,
      waiting([
        bill(1, { payee: "Acme https://vestiarion-approvals.example/o/acme/approvals" }),
        bill(2, { payee: "Acme @vestiarion_support", reasoning: "Confirm the new bank details at pay.acme-billing.com first." }),
        bill(3, { payee: "Acme /disconnect" }),
      ])
    );
    expect(autoLinks(message)).toEqual([]);
    expect(message).toContain(`⏸ <b>120.00 USDC</b> · Acme https:${SLASH}${SLASH}vestiarion-approvals[.]example/o/acme/approvals · held:`);
    expect(message).toContain(`⏸ <b>120.00 USDC</b> · Acme ${AT}vestiarion_support · held: Confirm the new bank details at pay[.]acme-billing[.]com first. ·`);
    expect(message).toContain(`⏸ <b>120.00 USDC</b> · Acme ${SLASH}disconnect · held:`);
    // Sent again as plain text, the first address in it, which Telegram would preview, is the first bill's Review link.
    const plain = plainText(message);
    expect(plain.indexOf("://")).toBe(plain.indexOf(`${ORIGIN}/o/acme/approvals#payable-${BILL(1)}`) + "https".length);
  });

  it("says nothing of bills when none waits, and the message reads as before", () => {
    const items = [item(), stopped(1)];
    expect(decisionsMessage(ACME, items, ORIGIN, waiting([]))).toBe(decisionsMessage(ACME, items, ORIGIN));
    expect(decisionsMessage(ACME, items, ORIGIN, null)).toBe(decisionsMessage(ACME, items, ORIGIN));
    expect(decisionsMessage(ACME, items, ORIGIN)).not.toContain(NEVER_APPROVES);
  });

  it("stays under Telegram's limit with many long bills: a bill that does not fit is counted among those in Approvals, never cut", () => {
    const bills = Array.from({ length: 12 }, (_, index) =>
      bill(index + 1, { payee: `Vendor ${index + 1} ${"y".repeat(90)}`, reasoning: `${"z".repeat(130)} is why.` })
    );
    const message = decisionsMessage(ACME, bills.map((_, index) => stopped(index + 1)), ORIGIN, waiting(bills));

    expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    const lines = message.split("\n").filter((line) => line.startsWith("⏸ "));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(10);
    for (const line of lines) expect(line).toMatch(/<a href="[^"]*">Review<\/a>$/);
    expect(message).toContain("12 bills wait for approval:");
    expect(message).toContain(`…and ${12 - lines.length} more in <a href="${ORIGIN}/o/acme/approvals">Approvals</a>.`);
    expect(message).not.toContain("the console");
    expect(message.endsWith(`\n${NEVER_APPROVES}`)).toBe(true);
  });

  it("keeps room for the bills before the other decisions, and counts in the console only the decisions left out", () => {
    const long = "x".repeat(200);
    const decisions = Array.from({ length: 30 }, (_, index) => item({ seq: index + 1, text: `Paid vendor ${index} ${long}`, detail: long }));
    const bills = Array.from({ length: 12 }, (_, index) => bill(index + 1, { reasoning: null }));
    const message = decisionsMessage(ACME, [...decisions, ...bills.map((_, index) => stopped(index + 1))], ORIGIN, waiting(bills));

    expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(message.split("\n").filter((line) => line.startsWith("⏸ <b>"))).toHaveLength(10);
    expect(message).toContain(`…and 2 more in <a href="${ORIGIN}/o/acme/approvals">Approvals</a>.`);
    const told = (message.match(/✅/g) ?? []).length;
    expect(told).toBeGreaterThan(0);
    expect(told).toBeLessThan(30);
    // The stopped bills are in the section, so they are not among the decisions counted in the console.
    expect(message).toContain(`…and ${30 - told} more in <a href="${ORIGIN}/o/acme/console">the console</a>.`);
    expect(message.endsWith(`\n${NEVER_APPROVES}`)).toBe(true);
  });

  it("turns back into words for the plain-text send, each Review link with its address", () => {
    const plain = plainText(decisionsMessage({ name: "A&B", slug: "acme" }, [stopped(1)], ORIGIN, waiting([bill(1, { payee: "Puka & Co" })])));
    expect(plain).toContain(`⏸ 120.00 USDC · Puka & Co · held: The invoice has no purchase order. · Review (${ORIGIN}/o/acme/approvals#payable-${BILL(1)})`);
    expect(plain).toContain("A&B · the agent decided 1 thing");
    expect(plain).not.toMatch(/<\/?(b|i|a)\b/);
    expect(plain.endsWith(`\n${NEVER_APPROVES}`)).toBe(true);
  });
});
