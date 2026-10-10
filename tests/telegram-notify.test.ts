import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import type { AgentActivity } from "@/lib/agent-activity-read";
import { CYCLE_STAGES, STAGE_REQUIRES } from "@/lib/agent/journal";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { TelegramResult } from "@/lib/telegram/client";
import { sendAgentDecisions } from "@/lib/telegram/notify";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { fakeTelegram, type TelegramCall } from "./support/fake-telegram";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The cycle's `telegram` stage (Telegram bot design R8): each linked chat is told the agent's decisions after its
 * cursor, and the cursor then moves past everything read. A failed send keeps the cursor for the next cycle; a chat
 * that blocked the bot is disconnected; a message Telegram refuses to parse is sent once as plain text, then passed.
 */

const { readActivityMock } = vi.hoisted(() => ({ readActivityMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-activity-read", () => ({ readAgentActivity: readActivityMock }));

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

beforeEach(() => {
  links = [];
  readActivityMock.mockReset();
});

function stage(answer?: (call: TelegramCall) => TelegramResult<unknown>) {
  const telegram = fakeTelegram(answer);
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "acme", name: "Acme" }) };
    if (sent.path === "/rest/v1/telegram_links" && sent.method === "GET") return { body: links };
    if (sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE") return { body: [{ id: sent.params.get("id")?.slice(3) }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
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

describe("the telegram stage in the cycle", () => {
  it("comes after every stage that moves money, just before slack, and needs no other stage to have succeeded", () => {
    expect(CYCLE_STAGES.slice(-2)).toEqual(["telegram", "slack"]);
    expect(STAGE_REQUIRES.telegram).toEqual([]);
  });
});
