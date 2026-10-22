import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { connectDiscordAction, removeDiscordAction, sendDiscordTestAction, type DiscordActionResult } from "@/app/actions/discord";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The Discord server actions (docs/superpowers/specs/2026-10-22-discord-design.md DC1, DC6): each asks for
 * `integrations.manage`, an owner's or admin's; connecting reads the webhook and posts a test message before anything is
 * saved, and saves nothing when Discord did not take it; no result ever carries the webhook's URL.
 */

const { ORG, USER, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000da1",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-000000000da2",
  mocks: {
    authorize: vi.fn(), revalidate: vi.fn(), readConnection: vi.fn(), saveConnection: vi.fn(), removeConnection: vi.fn(), clearFailure: vi.fn(),
    webhookUrlOf: vi.fn(), postToDiscord: vi.fn(), readDiscordWebhook: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: mocks.authorize }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: mocks.revalidate }));
vi.mock("@/lib/discord/connections", () => ({
  readConnection: mocks.readConnection, saveConnection: mocks.saveConnection, removeConnection: mocks.removeConnection, clearFailure: mocks.clearFailure,
  webhookUrlOf: mocks.webhookUrlOf,
}));
vi.mock("@/lib/discord/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord/api")>();
  return { ...actual, postToDiscord: mocks.postToDiscord, readDiscordWebhook: mocks.readDiscordWebhook };
});

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
vi.mock("@/lib/dal/scope", async () => {
  const { orgTestContext } = await import("./support/fake-supabase");
  return { inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG, userId: USER }), fn) };
});

const WEBHOOK_ID = "1234567890123456789";
const TOKEN = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123";
const CANONICAL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${TOKEN}`;
const INFO = { id: WEBHOOK_ID, channelId: "3234567890123456789", guildId: "2234567890123456789", name: "Finance" };
const CONNECTION = { id: "row-1", orgId: ORG, webhookId: WEBHOOK_ID, channelId: INFO.channelId, failures: 0, lastError: null };
const INITIAL: DiscordActionResult = { ok: false, message: "" };
const OK = { ok: true, status: 200, retryAfterMs: null, code: null };
const access = (role: string) => ({ ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "acme", name: "Acme Studio", mode: "live", role } });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "acme");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockResolvedValue(access("admin"));
  mocks.readConnection.mockResolvedValue({ ready: true, connection: null });
  mocks.readDiscordWebhook.mockResolvedValue({ ...OK, webhook: INFO });
  mocks.postToDiscord.mockResolvedValue(OK);
  mocks.saveConnection.mockResolvedValue(CONNECTION);
  mocks.webhookUrlOf.mockReturnValue(CANONICAL);
});

describe("connectDiscordAction", () => {
  it("asks for integrations.manage, reads the canonical URL, posts a test message, then saves", async () => {
    const pasted = ` https://discordapp.com/api/v10/webhooks/${WEBHOOK_ID}/${TOKEN}/ `;
    const result = await connectDiscordAction(INITIAL, form({ webhookUrl: pasted }));
    expect(result).toEqual({ ok: true, message: "Discord is connected. A test message was posted to the channel." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks.readDiscordWebhook).toHaveBeenCalledWith(CANONICAL);
    expect(mocks.postToDiscord).toHaveBeenCalledWith(CANONICAL, { content: expect.stringContaining("Vestiarion is connected to **Acme Studio**.") });
    expect(mocks.saveConnection).toHaveBeenCalledWith({ orgId: ORG, connectedBy: USER, webhook: { id: WEBHOOK_ID, token: TOKEN, url: CANONICAL }, info: INFO });
    // The test post comes before the save.
    expect(mocks.postToDiscord.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveConnection.mock.invocationCallOrder[0]);
    expect(mocks.revalidate).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("returns the refusal when authorize refuses, and calls nothing", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect(await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }))).toEqual({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect(mocks.readDiscordWebhook).not.toHaveBeenCalled();
    expect(mocks.postToDiscord).not.toHaveBeenCalled();
    expect(mocks.saveConnection).not.toHaveBeenCalled();
  });

  it("refuses a URL that is not a Discord webhook's, and calls nothing", async () => {
    const result = await connectDiscordAction(INITIAL, form({ webhookUrl: `https://discord.com.evil.com/api/webhooks/${WEBHOOK_ID}/${TOKEN}` }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("That is not a Discord webhook URL.");
    expect(mocks.readDiscordWebhook).not.toHaveBeenCalled();
    expect(mocks.postToDiscord).not.toHaveBeenCalled();
  });

  it.each([
    ["a webhook Discord says does not exist", { ok: false, status: 404, retryAfterMs: null, code: 10015 }, "Discord says this webhook does not exist."],
    ["Discord down", { ok: false, status: 503, retryAfterMs: null, code: null }, "Discord could not be reached. Try again in a moment. Nothing was saved."],
    ["an answer that names no channel", { ok: false, status: 200, retryAfterMs: null, code: null }, "Discord did not describe this webhook (200)."],
  ])("saves nothing and posts nothing for %s", async (_why, read, message) => {
    mocks.readDiscordWebhook.mockResolvedValue(read);
    const result = await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }));
    expect(result).toEqual({ ok: false, message: expect.stringContaining(message) });
    expect(mocks.postToDiscord).not.toHaveBeenCalled();
    expect(mocks.saveConnection).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, status: 400, retryAfterMs: null, code: 50035 }, "Discord did not take the test message (400). Nothing was saved."],
    [{ ok: false, status: 429, retryAfterMs: 3000, code: null }, "Discord asked Vestiarion to slow down. Try again in a minute. Nothing was saved."],
    [{ ok: false, status: 0, retryAfterMs: null, code: null }, "Discord could not be reached. Try again in a moment. Nothing was saved."],
    [{ ok: false, status: 404, retryAfterMs: null, code: 10015 }, "Discord says this webhook does not exist."],
  ])("saves nothing when the test message failed: %j", async (posted, message) => {
    mocks.postToDiscord.mockResolvedValue(posted);
    const result = await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }));
    expect(result).toEqual({ ok: false, message: expect.stringContaining(message) });
    expect(mocks.saveConnection).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("says Discord is not set up yet before migration 0139, and that it is connected already", async () => {
    mocks.readConnection.mockResolvedValue({ ready: false });
    expect(await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }))).toEqual({ ok: false, message: "Discord is not set up on this deployment yet." });
    mocks.readConnection.mockResolvedValue({ ready: true, connection: CONNECTION });
    expect(await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }))).toEqual({
      ok: false, message: "Discord is already connected. Disconnect it first to post to another channel.",
    });
    expect(mocks.postToDiscord).not.toHaveBeenCalled();
  });

  it("refuses a webhook whose answer names another id", async () => {
    mocks.readDiscordWebhook.mockResolvedValue({ ...OK, webhook: { ...INFO, id: "9234567890123456789" } });
    expect((await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }))).ok).toBe(false);
    expect(mocks.saveConnection).not.toHaveBeenCalled();
  });

  it("answers Try again, never the error, when saving fails", async () => {
    mocks.saveConnection.mockRejectedValue(new Error(`insert failed for ${CANONICAL}`));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await connectDiscordAction(INITIAL, form({ webhookUrl: CANONICAL }))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    error.mockRestore();
  });
});

describe("sendDiscordTestAction", () => {
  it("asks for integrations.manage and posts a test message to the saved webhook", async () => {
    mocks.readConnection.mockResolvedValue({ ready: true, connection: CONNECTION });
    expect(await sendDiscordTestAction(INITIAL, form({}))).toEqual({ ok: true, message: "A test message was posted to the Discord channel." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks.postToDiscord).toHaveBeenCalledWith(CANONICAL, { content: expect.stringContaining("A test message from Vestiarion for **Acme Studio**.") });
    expect(mocks.clearFailure).not.toHaveBeenCalled();
  });

  it("clears a recorded failure once Discord takes it", async () => {
    mocks.readConnection.mockResolvedValue({ ready: true, connection: { ...CONNECTION, failures: 2, lastError: "Discord answered 503." } });
    await sendDiscordTestAction(INITIAL, form({}));
    expect(mocks.clearFailure).toHaveBeenCalledWith("row-1");
  });

  it("disconnects a webhook Discord says is gone, as Discord's doing", async () => {
    mocks.readConnection.mockResolvedValue({ ready: true, connection: CONNECTION });
    mocks.postToDiscord.mockResolvedValue({ ok: false, status: 404, retryAfterMs: null, code: 10015 });
    const result = await sendDiscordTestAction(INITIAL, form({}));
    expect(result).toEqual({ ok: false, message: "Discord says this webhook no longer exists, so Discord was disconnected. Connect a new webhook." });
    expect(mocks.removeConnection).toHaveBeenCalledWith(CONNECTION, "discord", null);
  });

  it("says why a test did not go, and changes nothing", async () => {
    mocks.readConnection.mockResolvedValue({ ready: true, connection: CONNECTION });
    mocks.postToDiscord.mockResolvedValue({ ok: false, status: 502, retryAfterMs: null, code: null });
    expect(await sendDiscordTestAction(INITIAL, form({}))).toEqual({ ok: false, message: "Discord could not be reached. Try again in a moment." });
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("refuses without the permission, and says when nothing is connected", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect((await sendDiscordTestAction(INITIAL, form({}))).ok).toBe(false);
    expect(mocks.postToDiscord).not.toHaveBeenCalled();
    mocks.authorize.mockResolvedValue(access("owner"));
    expect(await sendDiscordTestAction(INITIAL, form({}))).toEqual({ ok: false, message: "Discord is not connected to this workspace." });
  });
});

describe("removeDiscordAction", () => {
  it("asks for integrations.manage and removes the connection from Settings, by the person", async () => {
    mocks.readConnection.mockResolvedValue({ ready: true, connection: CONNECTION });
    mocks.removeConnection.mockResolvedValue(true);
    expect(await removeDiscordAction(INITIAL, form({}))).toEqual({ ok: true, message: "Discord is disconnected. Bills waiting for approval are no longer posted there." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks.removeConnection).toHaveBeenCalledWith(CONNECTION, "settings", USER);
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("returns the refusal when authorize refuses, and removes nothing", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, message: "Your role in this workspace (accountant) cannot do that." });
    expect(await removeDiscordAction(INITIAL, form({}))).toEqual({ ok: false, message: "Your role in this workspace (accountant) cannot do that." });
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("says when nothing is connected", async () => {
    expect(await removeDiscordAction(INITIAL, form({}))).toEqual({ ok: true, message: "Discord is not connected to this workspace." });
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });
});
