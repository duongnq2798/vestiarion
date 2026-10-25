import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { changeDocumentRequests, DocumentRequestsError, readDocumentRequestsSetting } from "@/lib/document-requests/setting";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The owner's setting for asking vendors for missing documents (docs/superpowers/specs/2026-10-23-document-requests-design.md
 * ER1): off, shadow or on, read as off before migration 0142, changed by an upsert of the workspace's own row, refused
 * while a cycle runs, and signed as `document_requests_changed { by, from, to }`.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000d0c1";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const orgRow = () => ({
  id: ORG,
  slug: "northstar",
  name: "Northstar",
  mode: "live",
  ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
  circle_api_key_enc: null,
  circle_entity_secret_enc: null,
});

function settingFake(options: { setting?: string | "missing" | null; cycleRunning?: boolean; upsert?: FakeReply; checks?: boolean } = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    // Migration 0144's columns, which say documents are checked here (document checks DK15).
    if (request.path === "/rest/v1/document_requests") {
      return options.checks === false ? { status: 400, body: { code: "42703", message: "column document_requests.checked_at does not exist" } } : { body: [] };
    }
    if (request.path === "/rest/v1/approval_policies" && request.method === "GET") {
      if (options.setting === "missing") return { status: 400, body: { code: "42703", message: "column approval_policies.document_requests does not exist" } };
      return { body: options.setting ? [{ document_requests: options.setting }] : [] };
    }
    if (request.path === "/rest/v1/approval_policies" && request.method === "POST") return options.upsert ?? { status: 201, body: null };
    if (request.path === "/rest/v1/cycle_runs") return { body: options.cycleRunning ? [{ id: "run-1" }] : [] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-10-23T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

const ledgerBodies = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as Record<string, unknown>);

describe("reading the setting (ER1)", () => {
  it("is off for a workspace that never set it, and as stored once it did", async () => {
    const none = settingFake();
    expect(await none.run(() => readDocumentRequestsSetting(db()))).toEqual({ setting: "off", ready: true });
    const shadow = settingFake({ setting: "shadow" });
    expect(await shadow.run(() => readDocumentRequestsSetting(db()))).toEqual({ setting: "shadow", ready: true });
  });

  it("is off, and not available yet, before migration 0142", async () => {
    const before = settingFake({ setting: "missing" });
    expect(await before.run(() => readDocumentRequestsSetting(db()))).toEqual({ setting: "off", ready: false });
  });
});

describe("changing it (ER1)", () => {
  it("upserts the workspace's row and signs who changed it, from what, to what", async () => {
    const { fake, run } = settingFake({ setting: "off" });
    expect(await run(() => changeDocumentRequests({ actorId: ACTOR, to: "shadow" }))).toEqual({ from: "off", to: "shadow", checks: true });
    const upsert = fake.requests.find((r) => r.path === "/rest/v1/approval_policies" && r.method === "POST");
    expect(upsert?.params.get("on_conflict")).toBe("org_id");
    expect(upsert?.body).toMatchObject({ org_id: ORG, document_requests: "shadow", updated_by: ACTOR });
    const [entry] = ledgerBodies(fake.requests);
    expect(entry).toMatchObject({ p_actor: "human", p_domain: "system", p_action: "document_requests_changed", p_detail: { by: ACTOR, from: "off", to: "shadow" } });
    expect(entry.p_summary).toBe("Vestiarion now records which vendors it would ask for a missing document, and sends nothing");
  });

  it("says each change in words, and that documents are checked once migration 0144 ran (document checks DK1)", async () => {
    for (const [from, to, checks, summary] of [
      ["shadow", "on", true, "Vestiarion now asks vendors for a bill's missing purchase order or goods receipt, and checks what they send against the bill"],
      ["shadow", "on", false, "Vestiarion now asks vendors for a bill's missing purchase order or goods receipt"],
      ["on", "off", true, "Vestiarion no longer asks vendors for missing documents"],
    ] as const) {
      const { fake, run } = settingFake({ setting: from, checks });
      expect(await run(() => changeDocumentRequests({ actorId: ACTOR, to }))).toEqual({ from, to, checks });
      expect(ledgerBodies(fake.requests)[0].p_summary).toBe(summary);
    }
  });

  it("refuses a value it does not know, no change, a running cycle, and a database without 0142", async () => {
    await expect(settingFake().run(() => changeDocumentRequests({ actorId: ACTOR, to: "always" as never }))).rejects.toMatchObject({ code: "invalid" });
    await expect(settingFake({ setting: "on" }).run(() => changeDocumentRequests({ actorId: ACTOR, to: "on" }))).rejects.toMatchObject({ code: "unchanged" });
    await expect(settingFake({ cycleRunning: true }).run(() => changeDocumentRequests({ actorId: ACTOR, to: "on" }))).rejects.toMatchObject({ code: "cycle_running" });
    await expect(settingFake({ setting: "missing" }).run(() => changeDocumentRequests({ actorId: ACTOR, to: "on" }))).rejects.toMatchObject({ code: "not_ready" });
    const raced = settingFake({ upsert: { status: 400, body: { code: "PGRST204", message: "Could not find the 'document_requests' column" } } });
    await expect(raced.run(() => changeDocumentRequests({ actorId: ACTOR, to: "on" }))).rejects.toBeInstanceOf(DocumentRequestsError);
  });
});
