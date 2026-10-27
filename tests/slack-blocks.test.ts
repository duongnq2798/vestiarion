import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import { NEVER_APPROVES as DISCORD_NEVER_APPROVES } from "@/lib/discord/messages";
import { buildWaitingNotice, type NoticePolicy, type WaitingBill } from "@/lib/notifications/waiting-notice";
import {
  connectAnswer, decisionsMessage, helpAnswer, ITEMS_SHOWN, ledgerAnswer, mrkdwn, NEVER_APPROVES, outcomeLine, slackText, todayAnswer, waitingAnswer, withApprovalGiven,
  withOutcome, type CardView,
} from "@/lib/slack/blocks";
import { NEVER_APPROVES as TELEGRAM_NEVER_APPROVES } from "@/lib/telegram/messages";

/**
 * What Slack shows (Slack design S6–S8, S10, S14), as Block Kit: every value escaped for Slack's mrkdwn and every wallet
 * address shortened; a stopped payable's buttons only when deciding from Slack is on, Approve only when the payable
 * qualifies, each confirmed first; and a decided card rewritten to say who did what. While deciding from Slack is off,
 * the bills still waiting for approval end the message in their own section, each with a Review button to its card on
 * Approvals (docs/superpowers/specs/2026-10-27-slack-review-links-design.md SR2–SR4).
 */

const ORIGIN = "https://www.vestiarion.xyz";
const WORKSPACE = { name: "Northstar & Co", slug: "northstar" };
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const TX = `0x${"a".repeat(64)}`;

const item = (fields: Partial<ActivityItem> = {}): ActivityItem => {
  const base = {
  seq: 100, text: "Paid Centronex 0.30 USDC.", detail: "DeepSeek decided to pay it; checks passed.", tone: "done",
  path: `/invoices?open=${INVOICE}#trail-${INVOICE}`, pathLabel: "How it decided", txHash: TX, network: "arc-testnet", ...fields,
  } as ActivityItem;
  return { ...base, txUrl: fields.txUrl !== undefined ? fields.txUrl : base.txHash ? `https://explorer.testnet.arc.io/tx/${base.txHash}` : null };
};
const held = (fields: Partial<ActivityItem> = {}) =>
  item({ text: "Held Jiren 0.50 USDC for you.", detail: "No purchase order is on file.", tone: "stopped", path: `/approvals#payable-${INVOICE}`, pathLabel: "Decide in Approvals", txHash: null, invoiceId: INVOICE, ...fields });
const card = (fields: Partial<CardView> = {}): CardView => ({
  invoiceId: INVOICE, token: "vx1.card.token", approveRefusal: null, confirmText: "Pays 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000.", ...fields,
});

type Block = { type: string; block_id?: string; text?: { text: string }; elements?: Array<Record<string, unknown>> };
const blocksOf = (message: { blocks?: unknown[] }) => (message.blocks ?? []) as Block[];
const allText = (message: { text: string; blocks?: unknown[] }) => JSON.stringify(message);

/** A right-to-left override, a zero-width space, and half of an emoji standing alone. */
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const HALF = String.fromCharCode(0xd83d);

describe("mrkdwn", () => {
  it("escapes Slack's three characters and shortens a wallet address", () => {
    expect(mrkdwn("A & B <script> 0x1111222233334444555566667777888899990000")).toBe("A &amp; B &lt;script&gt; 0x1111…0000");
  });

  it("leaves a transaction hash whole", () => {
    expect(mrkdwn(TX)).toBe(TX);
  });

  it("removes hidden direction and zero-width characters, and half of an emoji, as Telegram and Discord do (SR4)", () => {
    expect(mrkdwn(`${RLO}Jir${ZWSP}en${HALF} & Co`)).toBe("Jiren &amp; Co");
    // A whole emoji is one character, and stays.
    expect(mrkdwn("Jiren 🎉")).toBe("Jiren 🎉");
  });
});

describe("slackText (SR4)", () => {
  it("keeps a value on one line, and escapes it as mrkdwn does", () => {
    expect(slackText("Acme\nLtd \t <b> & Co", 100)).toBe("Acme Ltd &lt;b&gt; &amp; Co");
  });

  it("clips before escaping, so no cut falls inside an escape or between the two halves of a character", () => {
    expect(slackText("&".repeat(20), 10)).toBe(`${"&amp;".repeat(9)}…`);
    const clipped = slackText(`${"a".repeat(8)}🎉🎉`, 10);
    expect(clipped).toBe(`${"a".repeat(8)}…`);
    expect(clipped).not.toMatch(/\p{Cs}/u);
  });
});

describe("decisionsMessage", () => {
  it("says what the agent did, why, and links its transaction and its page", () => {
    const message = decisionsMessage(WORKSPACE, [item()], ORIGIN, null);
    expect(message.text).toBe("Northstar &amp; Co: the agent decided 1 thing");
    const text = allText(message);
    expect(text).toContain("Paid Centronex 0.30 USDC.");
    expect(text).toContain("DeepSeek decided to pay it");
    expect(text).toContain(`https://explorer.testnet.arc.io/tx/${TX}`);
    expect(text).toContain(`${ORIGIN}/o/northstar/invoices?open=${INVOICE}#trail-${INVOICE}`);
  });

  it("gives a stopped payable only its link to Approvals while deciding from Slack is off", () => {
    const message = decisionsMessage(WORKSPACE, [held()], ORIGIN, null);
    const actions = blocksOf(message).filter((block) => block.type === "actions");
    expect(actions).toHaveLength(1);
    expect(actions[0].elements?.map((element) => element.action_id)).toEqual(["vx_open"]);
    expect(actions[0].elements?.[0].url).toBe(`${ORIGIN}/o/northstar/approvals#payable-${INVOICE}`);
  });

  it("gives it Approve and pay, Reject and Return when on, each carrying the card, the two that act confirmed first", () => {
    const message = decisionsMessage(WORKSPACE, [held()], ORIGIN, new Map([[INVOICE, card()]]));
    const [actions] = blocksOf(message).filter((block) => block.block_id === `payable-${INVOICE}`);
    const buttons = actions.elements ?? [];
    expect(buttons.map((button) => button.action_id)).toEqual(["vx_approve", "vx_reject", "vx_return", "vx_open"]);
    expect(buttons.slice(0, 3).map((button) => button.value)).toEqual(["vx1.card.token", "vx1.card.token", "vx1.card.token"]);
    expect(buttons[0]).toMatchObject({ style: "primary", confirm: { confirm: { text: "Approve and pay" } } });
    expect(JSON.stringify(buttons[0].confirm)).toContain("Pays 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000.");
    expect(buttons[1]).toMatchObject({ style: "danger", confirm: { confirm: { text: "Reject" } } });
    expect(buttons[2].confirm).toBeUndefined();
  });

  it("leaves Approve out, and says why, when the payable does not qualify", () => {
    const message = decisionsMessage(WORKSPACE, [held()], ORIGIN, new Map([[INVOICE, card({ approveRefusal: "It is above the 1 USDC this workspace allows from Slack." })]]));
    const [actions] = blocksOf(message).filter((block) => block.block_id === `payable-${INVOICE}`);
    expect(actions.elements?.map((element) => element.action_id)).toEqual(["vx_reject", "vx_return", "vx_open"]);
    const why = blocksOf(message).find((block) => block.block_id === `why-${INVOICE}`);
    expect(JSON.stringify(why)).toContain("Approve it in Vestiarion: It is above the 1 USDC this workspace allows from Slack.");
  });

  it("stays within Slack's 50 blocks, leaving the rest to the console", () => {
    const many = Array.from({ length: ITEMS_SHOWN + 5 }, (_, index) => item({ seq: index }));
    const message = decisionsMessage(WORKSPACE, many, ORIGIN, null);
    expect(blocksOf(message).length).toBeLessThanOrEqual(50);
    expect(allText(message)).toContain("and 5 more");
    expect(allText(message)).toContain(`${ORIGIN}/o/northstar/console`);
  });

  it("sets verbatim on every mrkdwn text, so Slack links nothing inside a value, and asks for no link previews (SR4)", () => {
    const message = decisionsMessage(WORKSPACE, [item({ text: "Paid Acme https://pay.acme.example @here #general 0.30 USDC." }), held()], ORIGIN, new Map([[INVOICE, card({ approveRefusal: "why" })]]));
    const texts = mrkdwnTexts(message.blocks ?? []);
    expect(texts.length).toBeGreaterThan(3);
    for (const text of texts) expect(text.verbatim, text.text).toBe(true);
    expect(message).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });
});

/** Every mrkdwn text object in some blocks, wherever it sits: a section's, a context's, a confirmation's. */
function mrkdwnTexts(value: unknown): Array<{ type: string; text: string; verbatim?: boolean }> {
  if (Array.isArray(value)) return value.flatMap(mrkdwnTexts);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const own = object.type === "mrkdwn" && typeof object.text === "string" ? [object as { type: string; text: string; verbatim?: boolean }] : [];
  return [...own, ...Object.values(object).flatMap(mrkdwnTexts)];
}

const BILL = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const REASONING = "The invoice has no purchase order. It waits for a person.";
const bill = (n: number, fields: Partial<WaitingBill> = {}): WaitingBill => ({
  id: BILL(n), payee: `Vendor ${n}`, amount: 120, currency: "USDC", status: "held", reasoning: REASONING, stopRule: null, ...fields,
});
/** What the activity says of a payable the agent stopped: the model's own words, and Decide in Approvals. */
const stopped = (n: number, fields: Partial<ActivityItem> = {}) =>
  held({ seq: 50 + n, text: `Held Vendor ${n} 120.00 USDC for you.`, detail: "The model's own words on it.", path: `/approvals#payable-${BILL(n)}`, invoiceId: BILL(n), ...fields });
const waiting = (bills: WaitingBill[], policy?: NoticePolicy) => ({ notice: buildWaitingNotice(bills, policy), invoiceIds: new Set(bills.map((one) => one.id)) });
const reviewUrl = (n: number) => `${ORIGIN}/o/northstar/approvals#payable-${BILL(n)}`;

type BillBlock = Block & { accessory?: Record<string, unknown> };
/** Each bill's section, as its text and its button's action and address. */
const billsOf = (message: { blocks?: unknown[] }) =>
  (blocksOf(message) as BillBlock[])
    .filter((block) => block.block_id?.startsWith("waiting-") && block.accessory)
    .map((block) => ({ text: block.text?.text, button: [block.accessory?.action_id, (block.accessory?.text as { text: string }).text, block.accessory?.url] }));

describe("the bills waiting for approval, while deciding from Slack is off (SR2)", () => {
  it("ends the message with the bills still waiting, in place of their blocks, each with a Review button to its card", () => {
    const message = decisionsMessage(
      WORKSPACE,
      [item(), stopped(1), stopped(2), stopped(3)],
      ORIGIN,
      null,
      waiting([bill(1), bill(2, { status: "flagged", currency: "EURC", amount: 75.5 }), bill(3, { status: "awaiting_info" })])
    );
    const blocks = blocksOf(message);
    expect(blocks[0].text?.text).toBe("*Northstar &amp; Co* · the agent decided 4 things");
    expect(blocks.map((block) => block.block_id).slice(-5)).toEqual(["waiting", `waiting-${BILL(1)}`, `waiting-${BILL(2)}`, `waiting-${BILL(3)}`, "waiting-never"]);
    expect(blocks.at(-5)?.text?.text).toBe("3 bills wait for approval:");
    expect(billsOf(message)).toEqual([
      { text: "*120.00 USDC* · Vendor 1 · held: The invoice has no purchase order.", button: ["vx_review", "Review", reviewUrl(1)] },
      { text: "*75.50 EURC* · Vendor 2 · flagged: The invoice has no purchase order.", button: ["vx_review", "Review", reviewUrl(2)] },
      { text: "*120.00 USDC* · Vendor 3 · waiting for details: The invoice has no purchase order.", button: ["vx_review", "Review", reviewUrl(3)] },
    ]);
    expect(blocks.at(-1)).toMatchObject({ type: "context", elements: [{ type: "mrkdwn", text: "Opening a link never approves anything." }] });
    const text = allText(message);
    expect(text).toContain("Paid Centronex 0.30 USDC.");
    for (const n of [1, 2, 3]) expect(text).not.toContain(`Held Vendor ${n}`);
    expect(text).not.toContain("The model's own words on it.");
    expect(text).not.toContain("Decide in Approvals");
  });

  it("lists a bill stopped twice once, and keeps the block of one a person decided since", () => {
    const message = decisionsMessage(WORKSPACE, [stopped(1), stopped(4), stopped(1, { seq: 60 })], ORIGIN, null, waiting([bill(1)]));
    expect(blocksOf(message)[0].text?.text).toBe("*Northstar &amp; Co* · the agent decided 3 things");
    expect(allText(message)).toContain("1 bill waits for approval:");
    expect(allText(message).match(/Vendor 1/g)).toHaveLength(1);
    // Vendor 4's bill no longer waits: its decision is told as it was made, with its own link.
    expect(allText(message)).toContain("Held Vendor 4 120.00 USDC for you.");
    const open = blocksOf(message).flatMap((block) => block.elements ?? []).find((element) => element.action_id === "vx_open");
    expect(open).toMatchObject({ text: { text: "Decide in Approvals" }, url: reviewUrl(4) });
  });

  it("keeps a shadow-mode verdict hold in its own block, with Give your verdict", () => {
    const verdict = stopped(5, { text: "Decided to pay Vendor 5 120.00 USDC; it waits for your verdict in shadow mode.", pathLabel: "Give your verdict", invoiceId: undefined });
    const message = decisionsMessage(WORKSPACE, [verdict, stopped(1)], ORIGIN, null, waiting([bill(1)]));
    expect(allText(message)).toContain("it waits for your verdict in shadow mode.");
    expect(blocksOf(message).flatMap((block) => block.elements ?? []).map((element) => (element.text as { text: string } | undefined)?.text)).toContain("Give your verdict");
    expect(billsOf(message)).toEqual([{ text: "*120.00 USDC* · Vendor 1 · held: The invoice has no purchase order.", button: ["vx_review", "Review", reviewUrl(1)] }]);
  });

  it("says a bill above the figure needs two approvals, and that an accountant can co-sign while co-signing is on", () => {
    const bills = [bill(1, { amount: 900 }), bill(2, { amount: 20 })];
    const off = billsOf(decisionsMessage(WORKSPACE, [stopped(1), stopped(2)], ORIGIN, null, waiting(bills, { twoApprovalsAbove: 500, accountantCosigns: false })));
    expect(off.map((one) => one.text)).toEqual([
      "*900.00 USDC* · Vendor 1 · held: The invoice has no purchase order. · needs two approvals",
      "*20.00 USDC* · Vendor 2 · held: The invoice has no purchase order.",
    ]);
    const on = billsOf(decisionsMessage(WORKSPACE, [stopped(1), stopped(2)], ORIGIN, null, waiting(bills, { twoApprovalsAbove: 500, accountantCosigns: true })));
    expect(on[0].text).toBe("*900.00 USDC* · Vendor 1 · held: The invoice has no purchase order. · needs two approvals, an accountant can co-sign");
    expect(on[1].text).toBe("*20.00 USDC* · Vendor 2 · held: The invoice has no purchase order.");
  });

  it("says why code stopped a bill, not the model's sentence that says the opposite, and the status alone when no reason was given", () => {
    const message = decisionsMessage(
      WORKSPACE,
      [stopped(1), stopped(2)],
      ORIGIN,
      null,
      waiting([bill(1, { reasoning: "The invoice is due today, so I am paying now.", stopRule: "invoice.pay_to_differs" }), bill(2, { reasoning: null, status: "awaiting_info" })])
    );
    expect(billsOf(message).map((one) => one.text)).toEqual([
      "*120.00 USDC* · Vendor 1 · held: Code stopped it: the invoice asks to be paid to a different address from the one on file.",
      "*120.00 USDC* · Vendor 2 · waiting for details",
    ]);
  });

  it("links each card on Approvals with no token, and says once that opening a link approves nothing, as Telegram and Discord say it", () => {
    const message = decisionsMessage(WORKSPACE, [stopped(1), stopped(2)], ORIGIN, null, waiting([bill(1), bill(2)]));
    const urls = blocksOf(message).flatMap((block) => [...(block.elements ?? []), (block as BillBlock).accessory ?? {}]).map((element) => element.url).filter(Boolean);
    expect(urls).toEqual([reviewUrl(1), reviewUrl(2)]);
    for (const url of urls) expect(url).not.toMatch(/token=|vx1\./);
    expect(NEVER_APPROVES).toBe(DISCORD_NEVER_APPROVES);
    expect(NEVER_APPROVES).toBe(TELEGRAM_NEVER_APPROVES);
    expect(allText(message).split(NEVER_APPROVES)).toHaveLength(2);
  });

  it("gives its blocks ids of their own, never a card's, so a decided card is rewritten as before", () => {
    const message = decisionsMessage(WORKSPACE, [item(), stopped(1), stopped(2)], ORIGIN, null, waiting(Array.from({ length: 12 }, (_, index) => bill(index + 1))));
    const ids = blocksOf(message).flatMap((block) => (block.block_id ? [block.block_id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/^(payable|why|approved)-/);
    expect(ids).toContain("waiting-more");
    expect(withOutcome(blocksOf(message), BILL(1), "Rejected by <@U0LINH>.")).toEqual(blocksOf(message));
  });

  it("shows a payee's name and the reason as plain text, on one line, with nothing Slack would link or mention", () => {
    const message = decisionsMessage(
      WORKSPACE,
      [stopped(1), stopped(2)],
      ORIGIN,
      null,
      waiting([
        bill(1, { payee: `A&B ${RLO}<https://evil.example|Approve>${ZWSP}\nLtd${HALF}`, reasoning: "Over the <!here> limit." }),
        bill(2, { payee: "Acme https://pay.acme.example @here #general" }),
      ])
    );
    const [first, second] = billsOf(message);
    expect(first.text).toBe("*120.00 USDC* · A&amp;B &lt;https://evil.example|Approve&gt; Ltd · held: Over the &lt;!here&gt; limit.");
    expect(second.text).toBe("*120.00 USDC* · Acme https://pay.acme.example @here #general · held: The invoice has no purchase order.");
    const sections = (blocksOf(message) as BillBlock[]).filter((block) => block.block_id?.startsWith("waiting-") && block.accessory);
    for (const section of sections) expect(section.text).toMatchObject({ type: "mrkdwn", verbatim: true });
  });

  it("draws no section while deciding from Slack is on: each waiting bill keeps its card, whose buttons act", () => {
    const cards = new Map([[INVOICE, card()]]);
    const items = [item(), held()];
    const message = decisionsMessage(WORKSPACE, items, ORIGIN, cards, waiting([bill(1, { id: INVOICE })]));
    expect(message).toEqual(decisionsMessage(WORKSPACE, items, ORIGIN, cards));
    expect(allText(message)).not.toContain("wait for approval");
    expect(allText(message)).not.toContain(NEVER_APPROVES);
    expect(allText(message)).toContain("vx_approve");
  });

  it("says nothing of bills when none waits, and the message reads as before", () => {
    const items = [item(), stopped(1)];
    expect(decisionsMessage(WORKSPACE, items, ORIGIN, null, waiting([]))).toEqual(decisionsMessage(WORKSPACE, items, ORIGIN, null));
    expect(allText(decisionsMessage(WORKSPACE, items, ORIGIN, null, null))).not.toContain(NEVER_APPROVES);
  });

  it("stays within Slack's 50 blocks and 3,000 characters a text at its fullest: the rest counted, in the console and in Approvals", () => {
    const long = "&<".repeat(400);
    const decisions = Array.from({ length: ITEMS_SHOWN + 5 }, (_, index) => item({ seq: index + 1, text: `Paid vendor ${index} ${long}`, detail: long }));
    const bills = Array.from({ length: 12 }, (_, index) =>
      bill(index + 1, { payee: `Vendor ${index + 1} ${"&".repeat(200)}`, reasoning: `${"<".repeat(400)} is why.`, amount: 123456789.123456 })
    );
    const message = decisionsMessage(WORKSPACE, [...decisions, ...bills.map((_, index) => stopped(index + 1))], ORIGIN, null, waiting(bills, { twoApprovalsAbove: 1, accountantCosigns: true }));
    const blocks = blocksOf(message);

    expect(blocks.length).toBeLessThanOrEqual(50);
    for (const text of mrkdwnTexts(blocks)) expect(text.text.length).toBeLessThanOrEqual(3000);
    const listed = billsOf(message);
    expect(listed).toHaveLength(10);
    // A bill's line is whole: what it needs is its last words, never cut.
    for (const one of listed) expect(one.text).toMatch(/ · needs two approvals, an accountant can co-sign$/);
    expect(allText(message)).toContain(`…and 5 more in <${ORIGIN}/o/northstar/console|the console>.`);
    expect(allText(message)).toContain(`…and 2 more in <${ORIGIN}/o/northstar/approvals|Approvals>.`);
    expect(blocks.at(-1)?.block_id).toBe("waiting-never");
  });
});

describe("a card one person approved, of a payment that needs two (two approvals T8)", () => {
  it("keeps its buttons for the second approval, with who approved just above them", () => {
    const original = blocksOf(decisionsMessage(WORKSPACE, [held(), item()], ORIGIN, new Map([[INVOICE, card()]])));
    const once = withApprovalGiven(original, INVOICE, "Approved by <@U0LINH>. One more approval, by another person, pays it.") as Block[];
    const at = once.findIndex((block) => block.block_id === `approved-${INVOICE}`);
    expect(once[at]).toEqual({
      type: "context", block_id: `approved-${INVOICE}`, elements: [{ type: "mrkdwn", text: "Approved by <@U0LINH>. One more approval, by another person, pays it.", verbatim: true }],
    });
    expect(once[at + 1].block_id).toBe(`payable-${INVOICE}`);
    expect(once.length).toBe(original.length + 1);
    // A later approval that still did not pay replaces the line rather than adding one.
    const twice = withApprovalGiven(once, INVOICE, "Approved by <@U0BAO>. One more approval, by another person, pays it.") as Block[];
    expect(twice.length).toBe(once.length);
    expect(JSON.stringify(twice)).toContain("U0BAO");
    expect(JSON.stringify(twice)).not.toContain("Approved by <@U0LINH>");
  });
});

describe("a decided card", () => {
  it("replaces the payable's buttons, and the reason Approve was missing, with who did what", () => {
    const original = blocksOf(decisionsMessage(WORKSPACE, [held(), item()], ORIGIN, new Map([[INVOICE, card({ approveRefusal: "why" })]])));
    const rewritten = withOutcome(original, INVOICE, "Rejected by <@U0LINH>.") as Block[];
    expect(rewritten.find((block) => block.block_id === `payable-${INVOICE}`)).toEqual({
      type: "context", block_id: `payable-${INVOICE}`, elements: [{ type: "mrkdwn", text: "Rejected by <@U0LINH>.", verbatim: true }],
    });
    expect(rewritten.find((block) => block.block_id === `why-${INVOICE}`)).toBeUndefined();
    expect(rewritten.length).toBe(original.length - 1);
  });

  it("names the network on a transaction's button and in each outcome: Arc mainnet for a workspace there (mainnet copy C1)", () => {
    const blocks = JSON.stringify(decisionsMessage(WORKSPACE, [item({ network: "arc-mainnet", txUrl: `https://explorer.arc.io/tx/${TX}` })], ORIGIN, new Map()));
    expect(blocks).toContain("Arc mainnet transaction");
    expect(blocks).not.toContain("Arc testnet");
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "Paid.", status: "paid", txRef: TX }, "arc-mainnet")).toBe(
      `Approved by <@U0LINH>. Circle confirmed the payment on Arc mainnet. <https://explorer.arc.io/tx/${TX}|Arc mainnet transaction>`
    );
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "", status: "matched", txRef: "circle-transfer-1" }, "arc-mainnet")).toBe(
      "Approved by <@U0LINH>. The payment was submitted; waiting for Circle to confirm it on Arc mainnet."
    );
  });

  it("says each outcome, with the transaction when one went out on Arc, and paid only once Circle confirmed it (I17)", () => {
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "Paid.", status: "paid", txRef: TX }, "arc-testnet")).toBe(
      `Approved by <@U0LINH>. Circle confirmed the payment on Arc testnet. <https://explorer.testnet.arc.io/tx/${TX}|Arc testnet transaction>`
    );
    // Submitted: Circle has it, and has not confirmed it.
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "", status: "matched", txRef: "circle-transfer-1" }, "arc-testnet")).toBe(
      "Approved by <@U0LINH>. The payment was submitted; waiting for Circle to confirm it on Arc testnet."
    );
    // Circle never answered the send, so no Circle id was recorded: an unknown outcome, never "sent" or "paid".
    const unanswered = outcomeLine("approve", "U0LINH", { ok: true, message: "", status: "matched", txRef: null }, "arc-testnet");
    expect(unanswered).toBe("Approved by <@U0LINH>. The payment was submitted, but Circle has not answered yet, so the outcome is unknown; nothing goes out again until it does.");
    expect(unanswered).not.toMatch(/\b(sent|paid)\b/i);
    // A sandbox's payment is simulated, and names no network or Circle.
    expect(
      outcomeLine("approve", "U0LINH", { ok: true, message: "", status: "paid", txRef: "sim_1", receipt: { network: "Sandbox (simulated)" } }, "arc-testnet")
    ).toBe("Approved by <@U0LINH>. The payment was simulated in the sandbox.");
    expect(outcomeLine("approve", "U0LINH", { ok: false, code: "transfer_failed", message: "The transfer failed: x. The invoice is held.", changed: true }, "arc-testnet")).toBe(
      "<@U0LINH> approved it. The transfer failed: x. The invoice is held."
    );
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "", status: "approved", txRef: null }, "arc-testnet")).toBe(
      "Approved by <@U0LINH>. One more approval, by another person, pays it."
    );
    expect(outcomeLine("reject", "U0LINH", { ok: true, message: "Rejected." }, "arc-testnet")).toBe("Rejected by <@U0LINH>.");
    expect(outcomeLine("return", "U0LINH", { ok: true, message: "" }, "arc-testnet")).toBe("Returned to the agent by <@U0LINH>. It usually decides it again within a minute.");
  });
});

describe("answers to /vestiarion", () => {
  it("says what is safe to spend today, what waits, and what the agent pays next", () => {
    const answer = todayAnswer("Northstar", {
      safeToSpend: 12.5, cash: 50, reserve: 0, dueIn30d: 37.5, eurcLeftOut: 0, shortOn: null, waiting: 2,
      scheduled: [{ name: "Centronex", amount: 2, currency: "USDC", on: "2026-10-05" }], lastCycleAt: "2026-10-03T07:55:00Z",
    }, `${ORIGIN}/o/northstar/console`);
    const text = allText(answer);
    expect(answer.response_type).toBe("ephemeral");
    expect(text).toContain("Safe to spend today: 12.50 USDC");
    expect(text).toContain("2 payments wait for a person");
    expect(text).toContain("Oct 5: Centronex 2.00 USDC");
  });

  it("lists what waits, and why, with where to decide it", () => {
    const answer = waitingAnswer("Northstar", [{ kind: "payable", id: INVOICE, name: "Jiren", amount: 0.5, currency: "USDC", status: "held", reason: "No purchase order." }], ORIGIN, "northstar");
    expect(allText(answer)).toContain("Jiren 0.50 USDC · held: No purchase order.");
    expect(allText(answer)).toContain(`${ORIGIN}/o/northstar/approvals#payable-${INVOICE}`);
    expect(allText(waitingAnswer("Northstar", [], ORIGIN, "northstar"))).toContain("Nothing waits for a person.");
  });

  it("labels a payable's link Review, says waiting for details, and says once that opening a link approves nothing (SR3)", () => {
    const answer = waitingAnswer(
      "Northstar",
      [
        { kind: "payable", id: INVOICE, name: "Jiren", amount: 0.5, currency: "USDC", status: "held", reason: "Code stopped it: it is above the counterparty's payment limit." },
        { kind: "payable", id: BILL(2), name: "Vendor 2", amount: 12, currency: "USDC", status: "awaiting_info", reason: null },
        { kind: "milestone", id: "m-1", name: "Puka: Design", amount: 40, currency: "USDC", status: "held", reason: null },
      ],
      ORIGIN,
      "northstar"
    );
    const [lines, never] = blocksOf(answer);
    expect(lines.text?.text.split("\n")).toEqual([
      "*Northstar* · 3 payments wait for a person",
      `• Jiren 0.50 USDC · held: Code stopped it: it is above the counterparty's payment limit. <${ORIGIN}/o/northstar/approvals#payable-${INVOICE}|Review>`,
      `• Vendor 2 12.00 USDC · waiting for details <${ORIGIN}/o/northstar/approvals#payable-${BILL(2)}|Review>`,
      `• Puka: Design 40.00 USDC · held <${ORIGIN}/o/northstar/contractors|Contractors>`,
    ]);
    expect(never).toMatchObject({ type: "context", elements: [{ type: "mrkdwn", text: NEVER_APPROVES, verbatim: true }] });
    expect(allText(answer)).not.toContain("Decide in Approvals");
    expect(allText(answer)).not.toContain("waiting for information");
    expect(answer).toMatchObject({ response_type: "ephemeral", unfurl_links: false, unfurl_media: false });
  });

  it("says nothing of links approving when no Review link is listed", () => {
    const verdict = waitingAnswer("Northstar", [{ kind: "payable", id: INVOICE, name: "Jiren", amount: 0.5, currency: "USDC", status: "held", reason: null, forVerdict: true }], ORIGIN, "northstar");
    expect(allText(verdict)).not.toContain(NEVER_APPROVES);
    expect(blocksOf(verdict)).toHaveLength(1);
  });

  it("shows names and reasons as plain text, and counts what would pass Slack's 3,000 characters, never cutting a link", () => {
    const facts = Array.from({ length: 10 }, (_, index) => ({
      kind: "payable" as const, id: BILL(index + 1), name: `Vendor ${index + 1}${RLO} ${"&".repeat(150)}`, amount: 1, currency: "USDC", status: "flagged", reason: `${"<".repeat(400)}\nwhy.`,
    }));
    const answer = waitingAnswer("Northstar", facts, ORIGIN, "northstar");
    const text = blocksOf(answer)[0].text?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(3000);
    const lines = text.split("\n").filter((line) => line.startsWith("• "));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(10);
    for (const line of lines) expect(line).toMatch(/ <https:\/\/www\.vestiarion\.xyz\/o\/northstar\/approvals#payable-[0-9a-f-]+\|Review>$/);
    expect(text).not.toContain(RLO);
    expect(text).toContain(`…and ${10 - lines.length} more in <${ORIGIN}/o/northstar/console|the console>.`);
    expect(blocksOf(answer).at(-1)).toMatchObject({ type: "context", elements: [{ text: NEVER_APPROVES }] });
  });

  it("says a payment held in shadow mode waits for a verdict, given in Vestiarion (review minor 7)", () => {
    const answer = waitingAnswer(
      "Northstar",
      [{ kind: "payable", id: INVOICE, name: "Jiren", amount: 0.5, currency: "USDC", status: "held", reason: "Matched and within the limit.", forVerdict: true }],
      ORIGIN,
      "northstar"
    );
    expect(allText(answer)).toContain("Jiren 0.50 USDC · waits for your verdict: Matched and within the limit.");
    expect(allText(answer)).toContain("Give your verdict");
    expect(allText(answer)).not.toContain("Decide in Approvals");
  });

  it("says whether the ledger verifies", () => {
    expect(allText(ledgerAnswer("Northstar", { valid: true, checkedEntries: 1071 } as never))).toContain("the ledger is intact: 1,071 entries");
    expect(allText(ledgerAnswer("Northstar", { valid: false, checkedEntries: 10, brokenAt: 7, reason: "signature does not verify" } as never))).toContain("does not verify at entry 7");
  });

  it("gives the one-time connect link only to the person who asked, and says what the commands do", () => {
    const answer = connectAnswer("https://www.vestiarion.xyz/integrations/slack/connect?code=abc");
    expect(answer.response_type).toBe("ephemeral");
    expect(allText(answer)).toContain("works once, for 10 minutes");
    expect(allText(helpAnswer(true, "Northstar"))).toContain("/vestiarion pause");
    expect(allText(helpAnswer(true, "Northstar"))).toContain("*Add invoice*");
    expect(allText(helpAnswer(false))).toContain("/vestiarion connect");
  });
});

describe("todayAnswer's wallet line", () => {
  it("names the USYC reserve it counts, and only when there is one", () => {
    const base = { safeToSpend: 154.38, cash: 0.23, reserve: 154.381758, dueIn30d: 0.2, eurcLeftOut: 0, shortOn: null, waiting: 0, scheduled: [], lastCycleAt: null };
    const answer = JSON.stringify(todayAnswer("testnet-2", base, "https://www.vestiarion.xyz/o/testnet-2/console"));
    expect(answer).toContain("The operating wallet holds 0.23 USDC and the USYC reserve 154.381758 USDC, back in seconds; 0.20 USDC is due in the next 30 days.");
    expect(JSON.stringify(todayAnswer("testnet-2", { ...base, reserve: 0 }, "https://www.vestiarion.xyz/o/testnet-2/console"))).not.toContain("USYC reserve");
  });
});

describe("a payment that has not confirmed (stuck-transfer alert D6)", () => {
  it("shows its transaction and its page, with no card to decide", () => {
    const stuck = item({ text: "Payment of 0.30 USDC to Jiren has not confirmed 18 min after it was submitted to Circle on Arc testnet.", detail: "Circle shows it stuck.", tone: "stopped" });
    const message = JSON.stringify(decisionsMessage(WORKSPACE, [stuck], ORIGIN, new Map()));
    expect(message).toContain("has not confirmed 18 min after it was submitted to Circle");
    expect(message).toContain("Arc testnet transaction");
    expect(message).not.toContain("vx_approve");
  });
});
