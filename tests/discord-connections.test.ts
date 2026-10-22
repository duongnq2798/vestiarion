import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  clearFailure, moveCursor, readConnection, recordFailure, removeConnection, saveConnection, webhookUrlOf, type DiscordConnection,
} from "@/lib/discord/connections";
import { discordPanelView } from "@/lib/discord/panel";
import { decryptSecret, encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A workspace's Discord channel webhook (docs/superpowers/specs/2026-10-22-discord-design.md DC1, DC2, DC5, DC6): the URL
 * kept only as an envelope bound to the workspace and column; the cursor at the ledger's head so the channel is never
 * sent the past; connecting and disconnecting in the ledger with Discord's ids only; and, before migration 0139, no
 * table and no failure.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d02";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d03";
const ROW_ID = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d04";
const WEBHOOK_ID = "1234567890123456789";
const CHANNEL = "3234567890123456789";
const GUILD = "2234567890123456789";
const TOKEN = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123";
const URL_ = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${TOKEN}`;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

function connectionRow(fields: Record<string, unknown> = {}) {
  return {
    id: ROW_ID, org_id: ORG, webhook_id: WEBHOOK_ID, channel_id: CHANNEL, guild_id: GUILD, name: "Finance", connected_by: USER,
    connected_at: "2026-10-22T08:00:00Z", notified_seq: "40", last_error: null, last_error_at: null, failures: 0,
    webhook_url_enc: encryptSecret(URL_, { orgId: ORG, column: "discord_webhooks.webhook_url_enc" }, keys()), ...fields,
  };
}

const CONNECTION: DiscordConnection = {
  id: ROW_ID, orgId: ORG, webhookId: WEBHOOK_ID, channelId: CHANNEL, guildId: GUILD, name: "Finance", connectedBy: USER, connectedAt: "2026-10-22T08:00:00Z",
  notifiedSeq: 40, lastError: null, lastErrorAt: null, failures: 2, webhookUrlEnc: { k: "t1", iv: "", tag: "", ct: "" },
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/ledger_entries") return { body: sent.params.get("select") === "seq" ? [{ seq: 77 }] : [] };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>, orgId = ORG) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(orgId, fn, { userId: USER }));
  return { fake, run };
}

const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_actor: string; p_detail: Record<string, unknown> });
const writes = (requests: RecordedRequest[], method: string) => requests.filter((sent) => sent.path === "/rest/v1/discord_webhooks" && sent.method === method);
const MISSING: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.discord_webhooks' in the schema cache" } };

describe("readConnection", () => {
  it("reads the workspace's connection by its id, and decrypts its URL only for its own workspace and column", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/discord_webhooks" ? { body: [connectionRow()] } : undefined));
    const read = await run(() => readConnection(ORG));
    expect(read.ready).toBe(true);
    const connection = read.ready ? read.connection : null;
    expect(connection).toMatchObject({ id: ROW_ID, webhookId: WEBHOOK_ID, channelId: CHANNEL, guildId: GUILD, name: "Finance", notifiedSeq: 40, failures: 0 });
    expect(webhookUrlOf(connection as DiscordConnection, keys())).toBe(URL_);
    expect(() => webhookUrlOf({ ...(connection as DiscordConnection), orgId: OTHER_ORG }, keys())).toThrow();
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/discord_webhooks")?.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("says none when the workspace has no connection", async () => {
    const { run } = world();
    expect(await run(() => readConnection(ORG))).toEqual({ ready: true, connection: null });
  });

  it("says it is not ready before migration 0139, and throws on any other failure", async () => {
    expect(await world((sent) => (sent.path === "/rest/v1/discord_webhooks" ? MISSING : undefined)).run(() => readConnection(ORG))).toEqual({ ready: false });
    const relation = { status: 404, body: { code: "42P01", message: 'relation "public.discord_webhooks" does not exist' } };
    expect(await world((sent) => (sent.path === "/rest/v1/discord_webhooks" ? relation : undefined)).run(() => readConnection(ORG))).toEqual({ ready: false });
    const broken = world((sent) => (sent.path === "/rest/v1/discord_webhooks" ? { status: 500, body: { code: "XX000", message: "boom" } } : undefined));
    await expect(broken.run(() => readConnection(ORG))).rejects.toThrow("boom");
  });
});

describe("saveConnection", () => {
  it("stores the canonical URL only as an envelope, the cursor at the ledger's head, and records discord_connected with ids only", async () => {
    let saved: Record<string, unknown> = {};
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/discord_webhooks" && sent.method === "POST") {
        saved = sent.body as Record<string, unknown>;
        return { body: [{ ...connectionRow(), ...saved, id: ROW_ID }] };
      }
      return undefined;
    });
    const connection = await run(() =>
      saveConnection({
        orgId: ORG, connectedBy: USER, webhook: { id: WEBHOOK_ID, token: TOKEN, url: URL_ },
        info: { id: WEBHOOK_ID, channelId: CHANNEL, guildId: GUILD, name: "Finance" },
      }, keys())
    );
    expect(connection.id).toBe(ROW_ID);
    expect(saved).toMatchObject({ org_id: ORG, webhook_id: WEBHOOK_ID, channel_id: CHANNEL, guild_id: GUILD, name: "Finance", connected_by: USER, notified_seq: 77 });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(decryptSecret(saved.webhook_url_enc as never, { orgId: ORG, column: "discord_webhooks.webhook_url_enc" }, keys())).toBe(URL_);
    // An insert, never an upsert: a workspace's connection is never replaced by another.
    expect(writes(fake.requests, "POST")[0].params.get("on_conflict")).toBeNull();

    const [entry] = ledger(fake.requests);
    expect(entry).toMatchObject({ p_action: "discord_connected", p_actor: "human", p_detail: { by: USER, webhookId: WEBHOOK_ID, channelId: CHANNEL } });
    expect(JSON.stringify(ledger(fake.requests))).not.toContain(TOKEN);
    expect(JSON.stringify(ledger(fake.requests))).not.toContain("discord.com");
  });

  it("refuses to write another workspace's connection", async () => {
    const { fake, run } = world();
    await expect(
      run(() => saveConnection({ orgId: OTHER_ORG, connectedBy: USER, webhook: { id: WEBHOOK_ID, token: TOKEN, url: URL_ }, info: { id: WEBHOOK_ID, channelId: CHANNEL, guildId: null, name: "x" } }, keys()))
    ).rejects.toThrow(/another workspace/);
    expect(writes(fake.requests, "POST")).toEqual([]);
  });
});

describe("removeConnection", () => {
  it("deletes the row and records discord_disconnected from Settings, by the person", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/discord_webhooks" && sent.method === "DELETE" ? { body: [{ id: ROW_ID }] } : undefined));
    expect(await run(() => removeConnection(CONNECTION, "settings", USER))).toBe(true);
    expect(writes(fake.requests, "DELETE")[0].params.get("id")).toBe(`eq.${ROW_ID}`);
    expect(ledger(fake.requests)[0]).toMatchObject({ p_action: "discord_disconnected", p_actor: "human", p_detail: { by: USER, webhookId: WEBHOOK_ID, via: "settings" } });
  });

  it("records a removal Discord caused as the system's, with no one", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/discord_webhooks" && sent.method === "DELETE" ? { body: [{ id: ROW_ID }] } : undefined));
    await run(() => removeConnection(CONNECTION, "discord", null));
    expect(ledger(fake.requests)[0]).toMatchObject({ p_action: "discord_disconnected", p_actor: "system", p_detail: { by: null, webhookId: WEBHOOK_ID, via: "discord" } });
  });

  it("records nothing when the row was already gone", async () => {
    const { fake, run } = world();
    expect(await run(() => removeConnection(CONNECTION, "settings", USER))).toBe(false);
    expect(ledger(fake.requests)).toEqual([]);
  });
});

describe("the cursor and the failures", () => {
  it("moves the cursor forward only", async () => {
    const { fake, run } = world();
    await run(() => moveCursor(ROW_ID, 90));
    const [patch] = writes(fake.requests, "PATCH");
    expect(patch.body).toEqual({ notified_seq: 90 });
    expect(patch.params.get("notified_seq")).toBe("lt.90");
  });

  it("records a failure, clipped, with one more in a row, and clears it", async () => {
    const { fake, run } = world();
    await run(() => recordFailure(CONNECTION, "x".repeat(400), new Date("2026-10-22T09:00:00Z")));
    const [recorded] = writes(fake.requests, "PATCH");
    expect(recorded.body).toEqual({ last_error: `${"x".repeat(299)}…`, last_error_at: "2026-10-22T09:00:00.000Z", failures: 3 });
    await run(() => clearFailure(ROW_ID));
    expect(writes(fake.requests, "PATCH")[1].body).toEqual({ last_error: null, last_error_at: null, failures: 0 });
  });
});

describe("discordPanelView", () => {
  it("shows the name, the channel, when and whether the viewer connected it, and the last error, never the URL", async () => {
    const row = connectionRow({ last_error: "Discord answered 503.", last_error_at: "2026-10-22T09:00:00Z" });
    const { run } = world((sent) => (sent.path === "/rest/v1/discord_webhooks" ? { body: [row] } : undefined));
    const view = await run(() => discordPanelView(ORG, USER));
    expect(view).toEqual({
      available: true, connected: true, name: "Finance", channelId: CHANNEL, connectedAt: "2026-10-22T08:00:00Z", connectedByYou: true,
      lastError: "Discord answered 503.", lastErrorAt: "2026-10-22T09:00:00Z",
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain("webhook_url_enc");
    expect(await run(() => discordPanelView(ORG, OTHER_ORG))).toMatchObject({ connectedByYou: false });
  });

  it("says not connected, or not available before migration 0139", async () => {
    expect(await world().run(() => discordPanelView(ORG, USER))).toEqual({ available: true, connected: false });
    expect(await world((sent) => (sent.path === "/rest/v1/discord_webhooks" ? MISSING : undefined)).run(() => discordPanelView(ORG, USER))).toEqual({ available: false });
  });
});
