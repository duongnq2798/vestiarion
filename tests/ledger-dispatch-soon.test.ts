import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { appendLedgerEntry } from "@/lib/ledger";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * Every appended ledger entry asks for its webhooks to go out right after the
 * response (webhooks design W3, as amended), and a failed append asks for
 * nothing.
 */
const dispatchSoon = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/dispatch-soon", () => ({ dispatchWebhooksSoon: dispatchSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d15a0";
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
  dispatchSoon.mockClear();
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function ledgerFake(appendFails = false) {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "northstar", name: "Northstar", mode: "live",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      if (appendFails) return { status: 500, body: { message: "ledger unavailable" } };
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
}

const ENTRY = { actor: "human", domain: "system", action: "agent_paused", summary: "The agent was paused", detail: {} } as const;

describe("appending a ledger entry", () => {
  it("asks for its webhooks to be sent right after the response", async () => {
    const fake = ledgerFake();
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => appendLedgerEntry(ENTRY)));
    expect(dispatchSoon).toHaveBeenCalledOnce();
  });

  it("asks for nothing when the append fails", async () => {
    const fake = ledgerFake(true);
    await expect(
      runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => appendLedgerEntry(ENTRY)))
    ).rejects.toThrow();
    expect(dispatchSoon).not.toHaveBeenCalled();
  });
});
