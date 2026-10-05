import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import {
  connectAnswer, decisionsMessage, helpAnswer, ITEMS_SHOWN, ledgerAnswer, mrkdwn, outcomeLine, todayAnswer, waitingAnswer, withApprovalGiven, withOutcome, type CardView,
} from "@/lib/slack/blocks";

/**
 * What Slack shows (Slack design S6–S8, S10, S14), as Block Kit: every value escaped for Slack's mrkdwn and every wallet
 * address shortened; a stopped payable's buttons only when deciding from Slack is on, Approve only when the payable
 * qualifies, each confirmed first; and a decided card rewritten to say who did what.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const WORKSPACE = { name: "Northstar & Co", slug: "northstar" };
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const TX = `0x${"a".repeat(64)}`;

const item = (fields: Partial<ActivityItem> = {}): ActivityItem => {
  const base = {
  seq: 100, text: "Paid Centronex 0.30 USDC.", detail: "DeepSeek decided to pay it; checks passed.", tone: "done",
  path: `/invoices#trail-${INVOICE}`, pathLabel: "How it decided", txHash: TX, ...fields,
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

describe("mrkdwn", () => {
  it("escapes Slack's three characters and shortens a wallet address", () => {
    expect(mrkdwn("A & B <script> 0x1111222233334444555566667777888899990000")).toBe("A &amp; B &lt;script&gt; 0x1111…0000");
  });

  it("leaves a transaction hash whole", () => {
    expect(mrkdwn(TX)).toBe(TX);
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
    expect(text).toContain(`${ORIGIN}/o/northstar/invoices#trail-${INVOICE}`);
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
});

describe("a card one person approved, of a payment that needs two (two approvals T8)", () => {
  it("keeps its buttons for the second approval, with who approved just above them", () => {
    const original = blocksOf(decisionsMessage(WORKSPACE, [held(), item()], ORIGIN, new Map([[INVOICE, card()]])));
    const once = withApprovalGiven(original, INVOICE, "Approved by <@U0LINH>. One more approval, by another person, pays it.") as Block[];
    const at = once.findIndex((block) => block.block_id === `approved-${INVOICE}`);
    expect(once[at]).toEqual({
      type: "context", block_id: `approved-${INVOICE}`, elements: [{ type: "mrkdwn", text: "Approved by <@U0LINH>. One more approval, by another person, pays it." }],
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
      type: "context", block_id: `payable-${INVOICE}`, elements: [{ type: "mrkdwn", text: "Rejected by <@U0LINH>." }],
    });
    expect(rewritten.find((block) => block.block_id === `why-${INVOICE}`)).toBeUndefined();
    expect(rewritten.length).toBe(original.length - 1);
  });

  it("says each outcome, with the transaction when one went out on Arc", () => {
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "Paid.", status: "paid", txRef: TX }, "arc-testnet")).toBe(
      `Approved and paid by <@U0LINH>. <https://explorer.testnet.arc.io/tx/${TX}|Arc testnet transaction>`
    );
    expect(outcomeLine("approve", "U0LINH", { ok: true, message: "", status: "matched", txRef: null }, "arc-testnet")).toBe(
      "Approved by <@U0LINH>. The payment was sent; Arc testnet is confirming it."
    );
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
