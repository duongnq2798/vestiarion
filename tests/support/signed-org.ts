import crypto from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";

/**
 * What `appendLedgerEntry` needs to sign inside an organization's scope, for one test file: master keys in the
 * environment while each test runs, and the organization's row as PostgREST returns it, holding a ledger signing key
 * those master keys open. Call it at the top of a describe or a file, so the hooks register there.
 */
export function signedOrgs() {
  const masterKeys = `t1:${crypto.randomBytes(32).toString("base64")}`;
  const pem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const saved = process.env.VESTIARION_MASTER_KEYS;
  beforeEach(() => {
    process.env.VESTIARION_MASTER_KEYS = masterKeys;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
    else process.env.VESTIARION_MASTER_KEYS = saved;
  });
  return {
    orgRow(orgId: string, fields: Record<string, unknown> = {}) {
      return {
        id: orgId,
        slug: "northstar",
        name: "Northstar",
        mode: "sandbox",
        circle_api_key_enc: null,
        circle_entity_secret_enc: null,
        ledger_signing_key_enc: encryptSecret(pem, { orgId, column: "ledger_signing_key_enc" }, parseMasterKeys(masterKeys)),
        ...fields,
      };
    },
  };
}

/** A ledger row as `append_ledger_entry` returns it, for a fake to answer with. */
export const APPENDED_LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-03T00:00:00Z", actor: "human", domain: "system", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};
