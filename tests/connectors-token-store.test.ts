import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  attachPending, connectionTokenStore, deleteTokens, expiredPendingGrants, pendingChoice, refreshTokenOf, saveTokens,
} from "@/lib/connectors/token-store";
import { decryptSecret, parseMasterKeys, type SecretEnvelope } from "@/lib/secrets";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Where a connection's tokens are kept (docs/superpowers/specs/2026-10-12-xero-connector-design.md X2, X5, X17): only as
 * envelopes bound to the workspace, the column and the row; only in the workspace's own scope; refreshed through the
 * lease and the compare-and-set; a pending choice only for the person who authorized it, before its deadline.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a02";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a03";
const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a04";
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const keys = parseMasterKeys(`t1:${Buffer.alloc(32, 7).toString("base64")}`);
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const TOKENS = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 1_800_000, scopes: ["offline_access", "accounting.invoices.read"] };

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined, orgId = ORG) {
  const fake = fakeSupabase((sent) => respond(sent) ?? { body: [] });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
  return { fake, run };
}

const inserted = (fake: ReturnType<typeof fakeSupabase>) =>
  fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST")?.body as Record<string, unknown>;

describe("saveTokens", () => {
  it("keeps each token as an envelope that opens only for its workspace, its column and its own row", async () => {
    const { fake, run } = world();
    const id = await run(() => saveTokens({ orgId: ORG, provider: "xero", connectionId: CONNECTION, authorizedBy: USER, tokens: TOKENS }, keys));
    const row = inserted(fake);
    expect(row).toMatchObject({ id, org_id: ORG, provider: "xero", connection_id: CONNECTION, authorized_by: USER, choices: null, choose_until: null });
    expect(JSON.stringify(row)).not.toContain("refresh-1");
    expect(JSON.stringify(row)).not.toContain("access-1");
    const refresh = row.refresh_token_enc as SecretEnvelope;
    expect(decryptSecret(refresh, { orgId: ORG, column: `accounting_tokens.refresh_token_enc/${id}` }, keys)).toBe("refresh-1");
    expect(() => decryptSecret(refresh, { orgId: ORG, column: `accounting_tokens.refresh_token_enc/${CONNECTION}` }, keys)).toThrow(/could not decrypt/);
    expect(() => decryptSecret(refresh, { orgId: ORG, column: `accounting_tokens.access_token_enc/${id}` }, keys)).toThrow(/could not decrypt/);
    expect(() => decryptSecret(refresh, { orgId: OTHER_ORG, column: `accounting_tokens.refresh_token_enc/${id}` }, keys)).toThrow(/could not decrypt/);
    expect(row.access_expires_at).toBe("2026-10-12T08:30:00.000Z");
    // A connection's earlier tokens go first.
    const removed = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "DELETE");
    expect(removed?.params.get("connection_id")).toBe(`eq.${CONNECTION}`);
    expect(removed?.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("keeps a pending grant with the organisations offered and its deadline", async () => {
    const { fake, run } = world();
    const choices = [{ externalOrgId: "t-1", name: "Demo Company (Global)", connectionId: "c-1" }];
    await run(() =>
      saveTokens({ orgId: ORG, provider: "xero", connectionId: null, authorizedBy: USER, tokens: TOKENS, pending: { choices, chooseUntil: "2026-10-12T08:10:00.000Z" } }, keys)
    );
    expect(inserted(fake)).toMatchObject({ connection_id: null, choices, choose_until: "2026-10-12T08:10:00.000Z" });
  });

  it("refuses to work outside the workspace's own scope", async () => {
    const { run } = world(undefined, OTHER_ORG);
    await expect(run(() => saveTokens({ orgId: ORG, provider: "xero", connectionId: CONNECTION, authorizedBy: USER, tokens: TOKENS }, keys))).rejects.toThrow(
      /own workspace's scope/
    );
  });
});

describe("connectionTokenStore", () => {
  async function storedRow() {
    const { fake, run } = world();
    const id = await run(() => saveTokens({ orgId: ORG, provider: "xero", connectionId: CONNECTION, authorizedBy: USER, tokens: TOKENS }, keys));
    return { ...inserted(fake), id, version: "3", choices: null, choose_until: null };
  }

  it("reads the connection's row, leases it, and stores a new pair over the version it read", async () => {
    const row = await storedRow();
    let storedArgs: Record<string, unknown> | undefined;
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET") return { body: [row] };
      if (sent.path === "/rest/v1/rpc/accounting_token_lease") return { body: [row] };
      if (sent.path === "/rest/v1/rpc/accounting_token_store") {
        storedArgs = sent.body as Record<string, unknown>;
        return { body: 4 };
      }
      return undefined;
    });
    const store = connectionTokenStore(ORG, CONNECTION, keys);
    const read = await run(() => store.read());
    expect(read).toMatchObject({ id: row.id, version: 3, accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 1_800_000 });
    expect(await run(() => store.lease("holder-1", 60))).toMatchObject({ version: 3 });
    const lease = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/accounting_token_lease");
    expect(lease?.body).toEqual({ p_org_id: ORG, p_token_id: row.id, p_holder: "holder-1", p_seconds: 60 });
    expect(await run(() => store.store("holder-1", 3, { ...TOKENS, accessToken: "access-2", refreshToken: "refresh-2" }))).toBe(true);
    expect(storedArgs).toMatchObject({ p_org_id: ORG, p_token_id: row.id, p_holder: "holder-1", p_version: 3 });
    expect(decryptSecret(storedArgs?.p_refresh_enc as SecretEnvelope, { orgId: ORG, column: `accounting_tokens.refresh_token_enc/${row.id}` }, keys)).toBe("refresh-2");
  });

  it("says a store was refused when the database answers no version", async () => {
    const row = await storedRow();
    const { run } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_tokens") return { body: [row] };
      if (sent.path === "/rest/v1/rpc/accounting_token_store") return { body: null };
      return undefined;
    });
    const store = connectionTokenStore(ORG, CONNECTION, keys);
    await run(() => store.read());
    expect(await run(() => store.store("holder-1", 3, TOKENS))).toBe(false);
  });

  it("opens the refresh token to revoke it, and deletes the row by its connection", async () => {
    const row = await storedRow();
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET" ? { body: [row] } : undefined));
    expect(await run(() => refreshTokenOf(ORG, { connectionId: CONNECTION }, keys))).toBe("refresh-1");
    await run(() => deleteTokens(ORG, { connectionId: CONNECTION }));
    const removed = fake.requests.find((sent) => sent.method === "DELETE");
    expect(removed?.params.get("connection_id")).toBe(`eq.${CONNECTION}`);
  });
});

describe("pending choices", () => {
  const pendingRow = (fields: Record<string, unknown> = {}) => ({
    id: "tok-p",
    provider: "xero",
    authorized_by: USER,
    choices: [{ externalOrgId: "t-1", name: "Demo Company (Global)", connectionId: "c-1" }, { name: "no id" }],
    choose_until: "2026-10-12T08:10:00.000Z",
    ...fields,
  });

  it("is read only by the person who authorized it, before its deadline", async () => {
    const { run } = world((sent) => (sent.path === "/rest/v1/accounting_tokens" ? { body: [pendingRow()] } : undefined));
    expect(await run(() => pendingChoice(ORG, "tok-p", USER, NOW))).toEqual({
      id: "tok-p",
      provider: "xero",
      choices: [{ externalOrgId: "t-1", name: "Demo Company (Global)", connectionId: "c-1" }],
      chooseUntil: "2026-10-12T08:10:00.000Z",
    });
    expect(await run(() => pendingChoice(ORG, "tok-p", "someone-else", NOW))).toBeNull();
    expect(await run(() => pendingChoice(ORG, "tok-p", USER, Date.parse("2026-10-12T08:10:00.000Z")))).toBeNull();
  });

  it("is attached to the connection picked once, before its deadline", async () => {
    const { fake, run } = world((sent) => (sent.method === "PATCH" ? { body: [{ id: "tok-p" }] } : undefined));
    expect(await run(() => attachPending(ORG, "tok-p", CONNECTION, NOW))).toBe(true);
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(patch?.body).toEqual({ connection_id: CONNECTION, choices: null, choose_until: null });
    expect(patch?.params.get("connection_id")).toBe("is.null");
    expect(patch?.params.get("choose_until")).toBe("gt.2026-10-12T08:00:00.000Z");
    const { run: runUsed } = world((sent) => (sent.method === "PATCH" ? { body: [] } : undefined));
    expect(await runUsed(() => attachPending(ORG, "tok-p", CONNECTION, NOW))).toBe(false);
  });

  it("lists the pending grants past their deadline across workspaces", async () => {
    const fake = fakeSupabase(() => ({ body: [{ id: "tok-p", org_id: ORG, provider: "xero" }] }));
    const listed = await runWith({ config, db: fake.client }, () => expiredPendingGrants(NOW));
    expect(listed).toEqual([{ orgId: ORG, tokenId: "tok-p", provider: "xero" }]);
    expect(fake.requests[0].params.get("choose_until")).toBe("lt.2026-10-12T08:00:00.000Z");
  });
});
