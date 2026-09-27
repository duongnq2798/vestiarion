import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { adoptEnvSecrets } from "@/lib/platform/adopt";
import { decryptSecret, type MasterKey } from "@/lib/secrets";

const ORG = "00000000-0000-4000-8000-000000000001";
const keys: MasterKey[] = [{ id: "v1", key: crypto.randomBytes(32) }];
const signing = crypto.generateKeyPairSync("ed25519");
const pem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const id = ledgerKeyId(signing.publicKey);
const escaped = pem.trim().split("\n").join("\\n");

describe("adoptEnvSecrets", () => {
  it("encrypts each secret for its own column, and the ledger key decrypts to a usable PEM", () => {
    const adopted = adoptEnvSecrets({
      orgId: ORG,
      env: { LEDGER_SIGNING_KEY: escaped, CIRCLE_API_KEY: "circle-key", CIRCLE_ENTITY_SECRET: "entity-secret" },
      keys,
      expectLedgerKeyId: id,
    });

    expect(adopted.ledgerKeyId).toBe(id);
    const ledger = decryptSecret(adopted.ledger_signing_key_enc, { orgId: ORG, column: "ledger_signing_key_enc" }, keys);
    expect(ledgerKeyId(crypto.createPrivateKey(ledger))).toBe(id);
    expect(decryptSecret(adopted.circle_api_key_enc!, { orgId: ORG, column: "circle_api_key_enc" }, keys)).toBe("circle-key");
    expect(decryptSecret(adopted.circle_entity_secret_enc!, { orgId: ORG, column: "circle_entity_secret_enc" }, keys)).toBe("entity-secret");
  });

  it("refuses a ledger key that is not the one that signed the chain, naming both ids", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const otherId = ledgerKeyId(other.publicKey);

    expect(() => adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: otherPem }, keys, expectLedgerKeyId: id }))
      .toThrow(new RegExp(`${otherId}.*${id}`));
  });

  it("refuses when there is no ledger key to adopt", () => {
    expect(() => adoptEnvSecrets({ orgId: ORG, env: {}, keys, expectLedgerKeyId: id })).toThrow(/LEDGER_SIGNING_KEY/);
  });

  it("leaves absent Circle credentials absent rather than encrypting an empty string", () => {
    const adopted = adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: pem }, keys, expectLedgerKeyId: id });
    expect(adopted.circle_api_key_enc).toBeNull();
    expect(adopted.circle_entity_secret_enc).toBeNull();
  });
});
