import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTelegramAction, disconnectTelegramAction } from "@/app/actions/telegram";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The Telegram card in Settings' Notifications section (Telegram bot design R4, R6): any member connects their own chat with a one-time
 * link, and disconnects only their own, whatever the form says. Authorization is a stand-in; the scope, the code and
 * the ledger entry are real, against a recorded supabase-js client.
 */

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const SOMEONE_ELSE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000171e";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const ENV = { TELEGRAM_BOT_TOKEN: "123456:AAH-secret-bot-token", TELEGRAM_WEBHOOK_SECRET: "s3cret_webhook-value-0123", TELEGRAM_BOT_USERNAME: "vestiarion_bot" };
const saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));

let links: unknown[] = [];

beforeEach(() => {
  Object.assign(process.env, ENV);
  links = [];
  authorizeMock.mockReset();
  authorizeMock.mockResolvedValue({
    ok: true,
    user: { id: USER, email: null },
    membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", role: "viewer" },
  });
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function workspace() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/telegram_links" && sent.method === "GET") return { body: links };
    if (sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE") return { body: [{ id: LINK_ID }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("connectTelegramAction", () => {
  it("gives the refusal to someone who is not a member, and makes no code", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "You are not a member of this workspace." });
    const { fake, run } = workspace();
    expect(await run(() => connectTelegramAction({ ok: false, message: "" }, form()))).toEqual({ ok: false, message: "You are not a member of this workspace." });
    expect(fake.requests).toEqual([]);
  });

  it("says so when this deployment has no bot, and makes no code", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { fake, run } = workspace();
    const result = await run(() => connectTelegramAction({ ok: false, message: "" }, form()));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("not set up") });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/telegram_link_codes")).toBe(false);
  });

  it("gives any member a one-time link to the bot, for their own membership", async () => {
    const { fake, run } = workspace();
    const result = await run(() => connectTelegramAction({ ok: false, message: "" }, form({ userId: SOMEONE_ELSE })));

    expect(result).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\/t\.me\/vestiarion_bot\?start=[A-Za-z0-9_-]{43}$/) });
    const code = new URL(result.url as string).searchParams.get("start") as string;
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/telegram_link_codes" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ org_id: ORG, user_id: USER, code_hash: crypto.createHash("sha256").update(code).digest("hex") });
  });
});

describe("disconnectTelegramAction", () => {
  it("disconnects the signed-in member's own link, never one the form names", async () => {
    links = [{ id: LINK_ID, org_id: ORG, user_id: USER, chat_id: 5550001, username: "linh_ops", active: true, notified_seq: 40, linked_at: "2026-10-03T08:00:00Z" }];
    const { fake, run } = workspace();
    const result = await run(() => disconnectTelegramAction({ ok: false, message: "" }, form({ userId: SOMEONE_ELSE })));

    expect(result).toEqual({ ok: true, message: "Telegram disconnected." });
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/telegram_links" && sent.method === "GET");
    expect(read?.params.get("user_id")).toBe(`eq.${USER}`);
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail).toMatchObject({ by: USER, userId: USER, via: "settings" });
  });

  it("removes nothing when the member has no chat connected", async () => {
    const { fake, run } = workspace();
    const result = await run(() => disconnectTelegramAction({ ok: false, message: "" }, form()));
    expect(result.ok).toBe(true);
    expect(fake.requests.some((sent) => sent.method === "DELETE")).toBe(false);
  });
});
