import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import type { AgentActivity } from "@/lib/agent-activity-read";
import { CYCLE_STAGES, STAGE_REQUIRES } from "@/lib/agent/journal";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { TelegramResult } from "@/lib/telegram/client";
import { plainText } from "@/lib/telegram/messages";
import { sendAgentDecisions } from "@/lib/telegram/notify";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { fakeTelegram, type TelegramCall } from "./support/fake-telegram";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The cycle's `telegram` stage (Telegram bot design R8): each linked chat is told the agent's decisions after its
 * cursor, and the cursor then moves past everything read. A failed send keeps the cursor for the next cycle; a chat
 * that blocked the bot is disconnected; a message Telegram refuses to parse is sent once as plain text, then passed.
 */

const { readActivityMock, usdcValueMock } = vi.hoisted(() => ({ readActivityMock: vi.fn(), usdcValueMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-activity-read", () => ({ readAgentActivity: readActivityMock }));
vi.mock("@/lib/agent/second-approval", () => ({ usdcValueOfLatestDecision: usdcValueMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const SETTINGS = { token: "123456:AAH-secret-bot-token", webhookSecret: "s3cret_webhook-value-0123", username: "vestiarion_bot" };
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const linkRow = (id: string, chatId: number, seq: number) => ({
  id, org_id: ORG, user_id: `0b6c1c9e-4a4f-4a7e-9b1e-0000000000${id.slice(-2)}`, chat_id: chatId, username: null, active: true, notified_seq: seq, linked_at: "2026-10-03T08:00:00Z",
});
const PAID: ActivityItem = {
  seq: 52, text: "Paid Centronex 0.35 USDC", detail: null, tone: "done", path: "/invoices", pathLabel: "Bills & receivables", txHash: null, txUrl: null, network: "arc-testnet",
};
const activity = (items: ActivityItem[], through: number): AgentActivity => ({ running: null, head: through, lastCycleAt: null, items, through });

let links: Array<ReturnType<typeof linkRow>> = [];
let invoices: Array<Record<string, unknown>> = [];
let invoicesReply: FakeReply | null = null;
let policy: Array<Record<string, unknown>> = [];
let policyReply: FakeReply | null = null;

beforeEach(() => {
  links = [];
  invoices = [];
  invoicesReply = null;
  policy = [];
  policyReply = null;
  readActivityMock.mockReset();
  usdcValueMock.mockReset();
});

function stage(answer?: (call: TelegramCall) => TelegramResult<unknown>) {
  const telegram = fakeTelegram(answer);
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "acme", name: "Acme" }) };
    if (sent.path === "/rest/v1/telegram_links" && sent.method === "GET") return { body: links };
    if (sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE") return { body: [{ id: sent.params.get("id")?.slice(3) }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/invoices") return invoicesReply ?? { body: invoices };
    if (sent.path === "/rest/v1/approval_policies") return policyReply ?? { body: policy };
    return { body: [] };
  });
  const run = (settings: typeof SETTINGS | null = SETTINGS) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => sendAgentDecisions({ settings, client: telegram.client, origin: "https://www.vestiarion.xyz" }))
    );
  const cursorMoves = () =>
    fake.requests
      .filter((sent) => sent.path === "/rest/v1/telegram_links" && sent.method === "PATCH")
      .map((sent) => [sent.params.get("id")?.slice(3), (sent.body as { notified_seq: number }).notified_seq]);
  return { telegram, fake, run, cursorMoves };
}

describe("sendAgentDecisions", () => {
  it("does nothing when the bot is not configured", async () => {
    links = [linkRow("l1", 101, 40)];
    const { telegram, fake, run } = stage();
    expect(await run(null)).toEqual([]);
    expect(telegram.calls).toEqual([]);
    expect(fake.requests.filter((sent) => sent.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it("reads once for chats at the same cursor, tells each, and moves each cursor past what it read", async () => {
    links = [linkRow("l1", 101, 40), linkRow("l2", 102, 40)];
    readActivityMock.mockResolvedValue(activity([PAID], 57));
    const { telegram, run, cursorMoves } = stage();

    const lines = await run();

    expect(readActivityMock).toHaveBeenCalledTimes(1);
    expect(readActivityMock).toHaveBeenCalledWith(40);
    expect(telegram.calls.filter((call) => call.method === "sendMessage").map((call) => call.args[0])).toEqual([101, 102]);
    expect(telegram.texts()[0]).toContain("<b>Acme</b> · the agent decided 1 thing");
    expect(cursorMoves()).toEqual([["l1", 57], ["l2", 57]]);
    expect(lines).toEqual([{ domain: "system", message: "Told 2 Telegram chats what the agent decided" }]);
  });

  it("moves the cursor past entries that make no message, and sends nothing", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([], 63));
    const { telegram, run, cursorMoves } = stage();

    expect(await run()).toEqual([]);
    expect(telegram.calls).toEqual([]);
    expect(cursorMoves()).toEqual([["l1", 63]]);
  });

  it("keeps the cursor when the send fails, so the next cycle sends again", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([PAID], 57));
    const { run, cursorMoves } = stage(() => ({ ok: false, status: 502, description: "Bad Gateway" }));

    expect(await run()).toEqual([]);
    expect(cursorMoves()).toEqual([]);
  });

  it("disconnects a chat that blocked the bot, and records it as the system's doing", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([PAID], 57));
    const { fake, run, cursorMoves } = stage(() => ({ ok: false, status: 403, description: "Forbidden: bot was blocked by the user" }));

    await run();

    expect(fake.requests.some((sent) => sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE")).toBe(true);
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_action: string; p_actor: string; p_detail: { via: string } };
    expect(entry).toMatchObject({ p_action: "telegram_disconnected", p_actor: "system", p_detail: { via: "blocked" } });
    expect(cursorMoves()).toEqual([]);
  });

  it("sends a message Telegram refused to parse once more as plain text, then moves on whatever it answers", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([{ ...PAID, text: "Paid A&B <Ltd> 0.35 USDC" }], 57));
    const { telegram, run, cursorMoves } = stage(() => ({ ok: false, status: 400, description: "Bad Request: can't parse entities" }));

    await run();

    const sends = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1].args[2]).toEqual({ plain: true });
    expect(String(sends[1].args[1])).toContain("Paid A&B <Ltd> 0.35 USDC");
    expect(cursorMoves()).toEqual([["l1", 57]]);
  });

  it("goes on to the next chat when one chat's read fails", async () => {
    links = [linkRow("l1", 101, 30), linkRow("l2", 102, 40)];
    readActivityMock.mockImplementation(async (since: number) => {
      if (since === 30) throw new Error("read failed");
      return activity([PAID], 57);
    });
    const { telegram, run, cursorMoves } = stage();

    await run();

    expect(telegram.calls.filter((call) => call.method === "sendMessage").map((call) => call.args[0])).toEqual([102]);
    expect(cursorMoves()).toEqual([["l2", 57]]);
  });
});

const ORIGIN = "https://www.vestiarion.xyz";
const INVOICE = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const stopped = (seq: number, n: number): ActivityItem => ({
  seq, text: `Held Vendor ${n} 120.00 USDC for you.`, detail: "The model's own words on it.", tone: "stopped", path: `/approvals#payable-${INVOICE(n)}`,
  pathLabel: "Decide in Approvals", txHash: null, txUrl: null, network: "arc-testnet", invoiceId: INVOICE(n),
});
/** Held in shadow mode for a person's verdict: the activity gives it no `invoiceId`. */
const VERDICT: ActivityItem = {
  seq: 58, text: "Decided to pay Vendor 9 120.00 USDC; it waits for your verdict in shadow mode.", detail: null, tone: "stopped", path: `/approvals#payable-${INVOICE(9)}`,
  pathLabel: "Give your verdict", txHash: null, txUrl: null, network: "arc-testnet",
};
const invoice = (n: number, fields: Record<string, unknown> = {}) => ({
  id: INVOICE(n), amount: "120.00", currency: "USDC", status: "held", direction: "payable", agent_reasoning: "The invoice has no purchase order. It waits for a person.",
  counterparties: { name: `Vendor ${n}` }, ...fields,
});
const review = (n: number) => `<a href="${ORIGIN}/o/acme/approvals#payable-${INVOICE(n)}">Review</a>`;

describe("the bills waiting for approval (docs/superpowers/specs/2026-10-23-telegram-review-links-design.md TG2)", () => {
  it("tells the bills still held, flagged or waiting for details in one section of the decisions message, in one send", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([PAID, stopped(53, 1), stopped(54, 2), stopped(55, 3), stopped(56, 4), VERDICT], 60));
    invoices = [
      invoice(1),
      invoice(2, { status: "flagged", amount: "75.5", currency: "EURC" }),
      invoice(3, { status: "awaiting_info" }),
      // Decided since the agent held it: no longer waiting.
      invoice(4, { status: "paid" }),
    ];
    const { telegram, run, cursorMoves } = stage();

    expect(await run()).toEqual([{ domain: "system", message: "Told 1 Telegram chat what the agent decided" }]);
    expect(telegram.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    const text = telegram.texts()[0];
    const lines = text.split("\n");
    expect(lines[0]).toBe("<b>Acme</b> · the agent decided 6 things");
    expect(lines.slice(-5)).toEqual([
      "3 bills wait for approval:",
      `⏸ <b>120.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · ${review(1)}`,
      `⏸ <b>75.50 EURC</b> · Vendor 2 · flagged: The invoice has no purchase order. · ${review(2)}`,
      `⏸ <b>120.00 USDC</b> · Vendor 3 · waiting for details: The invoice has no purchase order. · ${review(3)}`,
      "Opening a link never approves anything.",
    ]);
    expect(text).toContain("✅ Paid Centronex 0.35 USDC");
    // The bill paid since is told as the decision it was; the verdict hold keeps its own block.
    expect(text).toContain("⏸ Held Vendor 4 120.00 USDC for you.");
    expect(text).toContain(`<a href="${ORIGIN}/o/acme/approvals#payable-${INVOICE(9)}">Give your verdict</a>`);
    for (const n of [1, 2, 3]) expect(text).not.toContain(`Held Vendor ${n}`);
    expect(cursorMoves()).toEqual([["l1", 60]]);
  });

  it("reads the bills once for chats at the same cursor, in one query each, and the rules once in the stage", async () => {
    links = [linkRow("l1", 101, 40), linkRow("l2", 102, 40), linkRow("l3", 103, 30)];
    readActivityMock.mockImplementation(async (since: number) => activity(since === 30 ? [stopped(35, 5), stopped(53, 1)] : [stopped(53, 1), stopped(54, 2)], 60));
    invoices = [invoice(1), invoice(2), invoice(5)];
    policy = [{ two_approvals_above: "500", accountant_cosigns: false }];
    const { fake, telegram, run } = stage();

    await run();

    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/invoices").map((sent) => sent.params.get("id"))).toEqual([
      `in.(${INVOICE(1)},${INVOICE(2)})`,
      `in.(${INVOICE(5)},${INVOICE(1)})`,
    ]);
    // The figure, then the co-sign switch, once for the stage.
    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/approval_policies")).toHaveLength(2);
    expect(telegram.texts().map((text) => text.split("\n").filter((line) => line.startsWith("⏸ <b>")).length)).toEqual([2, 2, 2]);
  });

  it("reads neither bills nor rules when the agent stopped none", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([PAID, VERDICT], 60));
    const { fake, telegram, run } = stage();

    await run();

    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/invoices" || sent.path === "/rest/v1/approval_policies")).toEqual([]);
    expect(telegram.texts()[0]).not.toContain("Opening a link never approves anything.");
  });

  it("says a bill above the figure needs two approvals, weighing a EURC bill by its USDC value, and that an accountant can co-sign", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([stopped(53, 1), stopped(54, 2), stopped(55, 3)], 60));
    invoices = [invoice(1, { amount: "900" }), invoice(2, { currency: "EURC", amount: "450" }), invoice(3, { amount: "20" })];
    policy = [{ two_approvals_above: "500", accountant_cosigns: true }];
    usdcValueMock.mockResolvedValue(520);
    const { telegram, run } = stage();

    await run();

    expect(usdcValueMock).toHaveBeenCalledWith(INVOICE(2));
    const lines = telegram.texts()[0].split("\n").filter((line) => line.startsWith("⏸ <b>"));
    expect(lines).toEqual([
      `⏸ <b>900.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · needs two approvals, an accountant can co-sign · ${review(1)}`,
      `⏸ <b>450.00 EURC</b> · Vendor 2 · held: The invoice has no purchase order. · needs two approvals, an accountant can co-sign · ${review(2)}`,
      `⏸ <b>20.00 USDC</b> · Vendor 3 · held: The invoice has no purchase order. · ${review(3)}`,
    ]);
  });

  it("sends the same words as plain text when Telegram refuses the HTML, each Review link with its address", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([stopped(53, 1)], 60));
    invoices = [invoice(1, { counterparties: { name: "Puka & Co" } })];
    const { telegram, run, cursorMoves } = stage(() => ({ ok: false, status: 400, description: "Bad Request: can't parse entities" }));

    await run();

    const sends = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1].args[2]).toEqual({ plain: true });
    const plain = String(sends[1].args[1]);
    expect(plain).toBe(plainText(String(sends[0].args[1])));
    expect(plain).toContain(`⏸ 120.00 USDC · Puka & Co · held: The invoice has no purchase order. · Review (${ORIGIN}/o/acme/approvals#payable-${INVOICE(1)})`);
    expect(plain.endsWith("\nOpening a link never approves anything.")).toBe(true);
    expect(plain).not.toContain("<a ");
    expect(cursorMoves()).toEqual([["l1", 60]]);
  });

  it("still tells the decisions, each stopped bill in its own block, when the bills cannot be read", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([stopped(53, 1)], 60));
    invoicesReply = { status: 500, body: { code: "XX000", message: "boom" } };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { telegram, run, cursorMoves } = stage();

    expect(await run()).toHaveLength(1);

    expect(telegram.texts()[0]).toContain(`⏸ Held Vendor 1 120.00 USDC for you.\n<i>The model's own words on it.</i>\n<a href="${ORIGIN}/o/acme/approvals#payable-${INVOICE(1)}">Decide in Approvals</a>`);
    expect(telegram.texts()[0]).not.toContain("wait for approval");
    expect(cursorMoves()).toEqual([["l1", 60]]);
    expect(String(error.mock.calls[0])).toContain("telegram: waiting bills not read");
    error.mockRestore();
  });

  it("still tells the bills when the rules cannot be read, without saying what a bill needs", async () => {
    links = [linkRow("l1", 101, 40)];
    readActivityMock.mockResolvedValue(activity([stopped(53, 1)], 60));
    invoices = [invoice(1, { amount: "900" })];
    policyReply = { status: 500, body: { code: "XX000", message: "boom" } };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { telegram, run, cursorMoves } = stage();

    await run();

    expect(telegram.texts()[0]).toContain(`⏸ <b>900.00 USDC</b> · Vendor 1 · held: The invoice has no purchase order. · ${review(1)}`);
    expect(telegram.texts()[0]).not.toContain("two approvals");
    expect(cursorMoves()).toEqual([["l1", 60]]);
    expect(String(error.mock.calls[0])).toContain("telegram: the figure for two approvals was not read");
    error.mockRestore();
  });
});

describe("the telegram stage in the cycle", () => {
  it("comes after every stage that moves money, just before slack and discord, and needs no other stage to have succeeded", () => {
    expect(CYCLE_STAGES.slice(-3)).toEqual(["telegram", "slack", "discord"]);
    expect(STAGE_REQUIRES.telegram).toEqual([]);
  });
});
