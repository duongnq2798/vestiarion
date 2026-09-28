import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { resetDatabase } from "@/lib/seed";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Migration 0018 grants the tenant role no DELETE on ledger_entries: a reset
 * that could erase the audit trail would not be one. `resetDatabase` must
 * clear every other tenant table but leave the ledger alone, and say so in
 * the ledger itself.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const baseConfig = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
});

/** A throwaway signing key so `appendLedgerEntry` has something to sign with. */
function orgConfig() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { ...baseConfig, ledgerSigningKey: pem };
}

/** Answers the RPC with a plausible ledger row; every other request gets an empty array. */
function replyTo(request: RecordedRequest): FakeReply {
  if (request.path === "/rest/v1/rpc/append_ledger_entry") {
    const args = request.body as Record<string, unknown>;
    return {
      body: {
        seq: 1,
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        actor: args.p_actor,
        domain: args.p_domain,
        action: args.p_action,
        summary: args.p_summary,
        detail: args.p_detail,
        body_hash: args.p_body_hash,
        signature: args.p_signature,
        prev_hash: "0".repeat(64),
        hash: "1".repeat(64),
        signing_key_id: args.p_signing_key_id,
      },
    };
  }
  return { body: [] };
}

describe("resetDatabase", () => {
  it("deletes no ledger rows, keeps every delete inside the organization, and records the reset itself", async () => {
    const fake = fakeSupabase(replyTo);
    await runWith(orgTestContext({ config: orgConfig(), client: fake.client, orgId: ORG }), () => resetDatabase());

    const deletes = fake.requests.filter((request) => request.method === "DELETE");
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.some((request) => request.path === "/rest/v1/ledger_entries")).toBe(false);
    for (const request of deletes) {
      expect(carriesOrg(request, ORG)).toBe(true);
    }

    const append = fake.requests.find((request) => request.path === "/rest/v1/rpc/append_ledger_entry");
    expect(append).toBeDefined();
    const args = append!.body as Record<string, unknown>;
    expect(args.p_actor).toBe("system");
    expect(args.p_domain).toBe("system");
    expect(args.p_action).toBe("demo_reset");
    expect((args.p_detail as { cleared: string[] }).cleared).toContain("invoices");
    expect((args.p_detail as { cleared: string[] }).cleared).not.toContain("ledger_entries");
  });
});
