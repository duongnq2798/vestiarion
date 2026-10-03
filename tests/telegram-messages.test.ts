import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import type { InvoiceDraftRead } from "@/lib/invoice-document/draft";
import {
  decisionsMessage, draftMessage, helpMessage, ledgerMessage, MESSAGE_MAX, missingMessage, plainText,
} from "@/lib/telegram/messages";

/**
 * What the bot says (Telegram bot design R8–R12): HTML in which every value is escaped, links that are absolute and
 * stay inside the workspace, and messages that never pass Telegram's length limit, so Telegram never refuses one.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const WORKSPACE = { name: "Acme & Sons", slug: "acme" };
const TX = `0x${"ab".repeat(32)}`;

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    seq: 41,
    text: "Paid Centronex 0.35 USDC · 26 s after it was added",
    detail: "DeepSeek decided, as the written policy would.",
    tone: "done",
    path: "/invoices#invoice-1",
    pathLabel: "See it on AP / AR",
    txHash: TX,
    ...overrides,
  };
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

  it("links the transaction on Arc testnet only when there is one, and the page under the workspace", () => {
    const paid = decisionsMessage(WORKSPACE, [item()], ORIGIN);
    expect(paid).toContain(`<a href="https://testnet.arcscan.app/tx/${TX}">Arc testnet transaction</a>`);
    expect(paid).toContain('<a href="https://www.vestiarion.xyz/o/acme/invoices#invoice-1">See it on AP / AR</a>');

    const held = decisionsMessage(WORKSPACE, [item({ txHash: null, tone: "stopped", path: "/approvals#payable-9", pathLabel: "Decide in Approvals" })], ORIGIN);
    expect(held).not.toContain("arcscan");
    expect(held).toContain('<a href="https://www.vestiarion.xyz/o/acme/approvals#payable-9">Decide in Approvals</a>');
  });

  it("marks what was done apart from what was stopped", () => {
    const message = decisionsMessage(WORKSPACE, [item(), item({ seq: 42, tone: "stopped", text: "Held Jiren 3.00 USDC" })], ORIGIN);
    expect(message).toContain("✅ Paid Centronex");
    expect(message).toContain("⏸ Held Jiren");
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
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/invoices">');
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
  });

  it("names the workspace and the commands, and says the bot never approves or pays", () => {
    const message = helpMessage(true, "Acme & Sons");
    expect(message).toContain("Acme &amp; Sons");
    for (const command of ["/today", "/waiting", "/ledger", "/workspaces", "/disconnect"]) expect(message).toContain(command);
    expect(message).toContain("never approve or pay");
  });
});
