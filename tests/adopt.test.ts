import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { adoptEnvSecrets, ledgerKeyAdoptionRefusal } from "@/lib/platform/adopt";
import { decryptSecret, encryptSecret, type MasterKey } from "@/lib/secrets";

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
      expectLedgerKeyId: id, walletHost: null,
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

    expect(() => adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: otherPem }, keys, expectLedgerKeyId: id, walletHost: null }))
      .toThrow(new RegExp(`${otherId}.*${id}`));
  });

  it("refuses when there is no ledger key to adopt", () => {
    expect(() => adoptEnvSecrets({ orgId: ORG, env: {}, keys, expectLedgerKeyId: id, walletHost: null })).toThrow(/LEDGER_SIGNING_KEY/);
  });

  it.each(["own", null] as const)("adopts into a workspace whose wallet host is %s", (walletHost) => {
    const adopted = adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: pem }, keys, expectLedgerKeyId: id, walletHost });
    expect(adopted.ledgerKeyId).toBe(id);
  });

  it("refuses a hosted workspace, before reading anything: its Circle credentials are the platform's hosted pair (review minor 3)", () => {
    expect(() =>
      adoptEnvSecrets({
        orgId: ORG,
        env: { LEDGER_SIGNING_KEY: escaped, CIRCLE_API_KEY: "circle-key", CIRCLE_ENTITY_SECRET: "entity-secret" },
        keys,
        expectLedgerKeyId: id,
        walletHost: "hosted",
      })
    ).toThrow(
      "This workspace uses a hosted testnet wallet (wallet_host = 'hosted'); refusing to adopt this environment's secrets into it"
    );
  });

  it("leaves absent Circle credentials absent rather than encrypting an empty string", () => {
    const adopted = adoptEnvSecrets({ orgId: ORG, env: { LEDGER_SIGNING_KEY: pem }, keys, expectLedgerKeyId: id, walletHost: null });
    expect(adopted.circle_api_key_enc).toBeNull();
    expect(adopted.circle_entity_secret_enc).toBeNull();
  });
});

describe("ledgerKeyAdoptionRefusal — org:adopt-env never undoes a rotation (final review, Fix 1)", () => {
  const sealLedger = (value: string) => encryptSecret(value, { orgId: ORG, column: "ledger_signing_key_enc" }, keys);
  const replacement = crypto.generateKeyPairSync("ed25519");
  const replacementPem = replacement.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const replacementId = ledgerKeyId(replacement.publicKey);
  const retiredItem = {
    id,
    publicKeyPem: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    retiredAt: "2026-09-30T12:34:56.000Z",
  };

  it("refuses a key this workspace has retired, naming when", () => {
    const refusal = ledgerKeyAdoptionRefusal({
      orgId: ORG,
      row: { ledger_signing_key_enc: sealLedger(replacementPem), ledger_retired_keys: [retiredItem] },
      envKeyId: id,
      keys,
    });
    expect(refusal).toBe(
      "That key was retired on 2026-09-30T12:34:56.000Z; it can no longer sign for this workspace. Rotate from Settings → Ledger signing key instead."
    );
  });

  it("refuses a retired key even when the row's signing key cannot be read", () => {
    const refusal = ledgerKeyAdoptionRefusal({
      orgId: ORG,
      row: { ledger_signing_key_enc: null, ledger_retired_keys: [retiredItem] },
      envKeyId: id,
      keys,
    });
    expect(refusal).toMatch(/^That key was retired on /);
  });

  it("refuses to replace a different key the workspace already signs with, naming both ids", () => {
    const refusal = ledgerKeyAdoptionRefusal({
      orgId: ORG,
      row: { ledger_signing_key_enc: sealLedger(replacementPem), ledger_retired_keys: [] },
      envKeyId: id,
      keys,
    });
    expect(refusal).toBe(
      `This workspace already signs with key ${replacementId}; adopting ${id} would replace it. Rotate from Settings → Ledger signing key instead.`
    );
  });

  it("allows re-adopting the key that is already stored, so the command stays idempotent", () => {
    expect(
      ledgerKeyAdoptionRefusal({
        orgId: ORG,
        row: { ledger_signing_key_enc: sealLedger(pem), ledger_retired_keys: [] },
        envKeyId: id,
        keys,
      })
    ).toBeNull();
  });

  it("allows adopting into a workspace that has no key stored yet", () => {
    expect(
      ledgerKeyAdoptionRefusal({ orgId: ORG, row: { ledger_signing_key_enc: null, ledger_retired_keys: [] }, envKeyId: id, keys })
    ).toBeNull();
  });

  it("names no key material in a refusal", () => {
    const refusal = ledgerKeyAdoptionRefusal({
      orgId: ORG,
      row: { ledger_signing_key_enc: sealLedger(replacementPem), ledger_retired_keys: [] },
      envKeyId: id,
      keys,
    });
    expect(refusal).not.toContain("PRIVATE");
    expect(refusal).not.toContain("BEGIN");
  });
});

describe("the org:adopt-env script", () => {
  const script = readFileSync(path.join(process.cwd(), "scripts", "org-adopt-env.ts"), "utf8");

  it("reads the stored key and the retired keys, and asks ledgerKeyAdoptionRefusal before writing", () => {
    expect(script).toMatch(/select\("[^"]*ledger_signing_key_enc[^"]*ledger_retired_keys[^"]*"\)/);
    const refusal = script.indexOf("ledgerKeyAdoptionRefusal(");
    const write = script.indexOf(".update(");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(write);
  });
});
