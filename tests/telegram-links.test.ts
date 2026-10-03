import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  claimLinkCode, createLinkCode, disconnect, memberRole, moveCursor, recordConnected, type TelegramLink,
} from "@/lib/telegram/links";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a Telegram chat (Telegram bot design R4–R6): a one-time code whose hash alone is stored, claimed through
 * the database's own function; a cursor that only moves forward; and the ledger entries that say a chat was connected
 * or disconnected, with the Telegram username masked.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000171e";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const LINK: TelegramLink = {
  id: LINK_ID, orgId: ORG, userId: USER, chatId: 5550001, username: "linh_ops", active: true, notifiedSeq: 40, linkedAt: "2026-10-03T08:00:00Z",
};

function platform(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

const ledger = (requests: RecordedRequest[]) =>
  requests
    .filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")
    .map((sent) => sent.body as { p_actor: string; p_domain: string; p_action: string; p_detail: Record<string, unknown> });

describe("createLinkCode", () => {
  it("stores only the SHA-256 of a 43-character code, expiring ten minutes later", async () => {
    const { fake, run } = platform();
    const { code, expiresAt } = await run(() => createLinkCode(ORG, USER, new Date("2026-10-03T08:00:00Z")));

    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe("2026-10-03T08:10:00.000Z");
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/telegram_link_codes" && sent.method === "POST");
    expect(insert?.body).toEqual({
      org_id: ORG,
      user_id: USER,
      code_hash: crypto.createHash("sha256").update(code).digest("hex"),
      expires_at: "2026-10-03T08:10:00.000Z",
    });
    expect(JSON.stringify(fake.requests.map((sent) => sent.body))).not.toContain(code);
  });
});

describe("claimLinkCode", () => {
  it.each(["", "short", "a".repeat(44), `${"a".repeat(42)}/`])("asks nothing for a code that is not one we make (%s)", async (code) => {
    const { fake, run } = platform();
    expect(await run(() => claimLinkCode(code, 5550001, "linh_ops"))).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  it("claims through the database by the code's hash, and reads the link it made", async () => {
    const code = "A".repeat(43);
    const { fake, run } = platform((sent) =>
      sent.path === "/rest/v1/rpc/telegram_claim_code"
        ? { body: [{ id: LINK_ID, org_id: ORG, user_id: USER, chat_id: 5550001, username: "linh_ops", active: true, notified_seq: 40, linked_at: "2026-10-03T08:00:00Z" }] }
        : undefined
    );

    expect(await run(() => claimLinkCode(code, 5550001, "linh_ops"))).toEqual(LINK);
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/rpc/telegram_claim_code")?.body).toEqual({
      p_code_hash: crypto.createHash("sha256").update(code).digest("hex"),
      p_chat_id: 5550001,
      p_username: "linh_ops",
    });
  });

  it("answers null when the database claims nothing: used, expired or unknown", async () => {
    const { run } = platform();
    expect(await run(() => claimLinkCode("B".repeat(43), 5550001, null))).toBeNull();
  });
});

describe("moveCursor", () => {
  it("moves a link's cursor only forward", async () => {
    const { fake, run } = platform();
    await run(() => moveCursor(LINK_ID, 57));

    const update = fake.requests.find((sent) => sent.path === "/rest/v1/telegram_links" && sent.method === "PATCH");
    expect(update?.body).toEqual({ notified_seq: 57 });
    expect(update?.params.get("id")).toBe(`eq.${LINK_ID}`);
    expect(update?.params.get("notified_seq")).toBe("lt.57");
  });
});

describe("recordConnected and disconnect", () => {
  it("records a connection in the link's workspace, the username masked", async () => {
    const { fake, run } = platform();
    await run(() => withOrg(ORG, () => recordConnected(LINK), { userId: USER }));

    expect(ledger(fake.requests)).toEqual([
      expect.objectContaining({ p_actor: "human", p_domain: "system", p_action: "telegram_connected", p_detail: { by: USER, username: "@li***" } }),
    ]);
  });

  it("deletes the link and records who disconnected it, and how", async () => {
    const { fake, run } = platform((sent) =>
      sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE" ? { body: [{ id: LINK_ID }] } : undefined
    );
    expect(await run(() => withOrg(ORG, () => disconnect(LINK, "telegram", USER), { userId: USER }))).toBe(true);

    const deleted = fake.requests.find((sent) => sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE");
    expect(deleted?.params.get("id")).toBe(`eq.${LINK_ID}`);
    expect(ledger(fake.requests)).toEqual([
      expect.objectContaining({
        p_actor: "human",
        p_action: "telegram_disconnected",
        p_detail: { by: USER, userId: USER, via: "telegram", username: "@li***" },
      }),
    ]);
  });

  it("records a link Telegram refused as the system's doing", async () => {
    const { fake, run } = platform((sent) =>
      sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE" ? { body: [{ id: LINK_ID }] } : undefined
    );
    await run(() => withOrg(ORG, () => disconnect({ ...LINK, username: null }, "blocked", null)));

    expect(ledger(fake.requests)).toEqual([
      expect.objectContaining({ p_actor: "system", p_detail: { by: null, userId: USER, via: "blocked", username: null } }),
    ]);
  });

  it("records nothing when the link was already gone", async () => {
    const { fake, run } = platform();
    expect(await run(() => withOrg(ORG, () => disconnect(LINK, "settings", USER), { userId: USER }))).toBe(false);
    expect(ledger(fake.requests)).toEqual([]);
  });

  it("refuses to write into another workspace's ledger", async () => {
    const { fake, run } = platform((sent) => (sent.path === "/rest/v1/orgs" ? { body: orgs.orgRow(OTHER_ORG) } : undefined));
    await expect(run(() => withOrg(OTHER_ORG, () => recordConnected(LINK)))).rejects.toThrow(/another workspace/);
    expect(ledger(fake.requests)).toEqual([]);
  });
});

describe("memberRole", () => {
  it("reads the member's role, or null for no membership", async () => {
    const { run } = platform((sent) =>
      sent.path === "/rest/v1/memberships" ? { body: sent.params.get("user_id") === `eq.${USER}` ? [{ role: "approver" }] : [] } : undefined
    );
    expect(await run(() => memberRole(ORG, USER))).toBe("approver");
    expect(await run(() => memberRole(ORG, "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2"))).toBeNull();
  });
});
