import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { FOUNDING_ORG_ID, orgConfig, type OrgRow } from "@/lib/dal/org-config";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";

const OTHER_ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const keys = parseMasterKeys(`t1:${crypto.randomBytes(32).toString("base64")}`);
const strangerKeys = parseMasterKeys(`t9:${crypto.randomBytes(32).toString("base64")}`);
const ledgerPem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const base = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  BUSINESS_NAME: "From the environment",
  LEDGER_SIGNING_KEY: "env-ledger-key-must-not-leak",
  LEDGER_PUBLIC_KEY: "env-public-key",
  LEDGER_RETIRED_PUBLIC_KEYS: "-----BEGIN PUBLIC KEY-----\nretired\n-----END PUBLIC KEY-----",
  CIRCLE_API_KEY: "env-circle-key-must-not-leak",
  CIRCLE_ENTITY_SECRET: "env-circle-secret-must-not-leak",
});

function row(orgId: string, sealed: Partial<Record<"ledger" | "apiKey" | "entity", string>> = {}, sealWith = keys, sealFor = orgId): OrgRow {
  const seal = (value: string | undefined, column: string) =>
    value ? encryptSecret(value, { orgId: sealFor, column }, sealWith) : null;
  return {
    id: orgId,
    slug: orgId === FOUNDING_ORG_ID ? "founding" : "northstar",
    name: orgId === FOUNDING_ORG_ID ? "Vestiarion workspace" : "Northstar Studio",
    mode: orgId === FOUNDING_ORG_ID ? "live" : "sandbox",
    ledger_signing_key_enc: seal(sealed.ledger, "ledger_signing_key_enc"),
    circle_api_key_enc: seal(sealed.apiKey, "circle_api_key_enc"),
    circle_entity_secret_enc: seal(sealed.entity, "circle_entity_secret_enc"),
  };
}

describe("orgConfig", () => {
  it("uses the organization's own name and decrypted secrets", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem, apiKey: "org-key", entity: "org-secret" }), keys);
    expect(warnings).toEqual([]);
    expect(config.businessName).toBe("Northstar Studio");
    expect(config.ledgerSigningKey).toBe(ledgerPem);
    expect(config.chain.circleApiKey).toBe("org-key");
    expect(config.chain.circleEntitySecret).toBe("org-secret");
  });

  it("never falls back to the environment's secrets for an organization that has none", () => {
    const { config } = orgConfig(base, row(OTHER_ORG), keys);
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(config.ledgerPublicKey).toBeUndefined();
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("must-not-leak");
  });

  it("never lets an organization generate a ledger key on demand", () => {
    expect(orgConfig({ ...base, allowGeneratedLedgerKey: true }, row(OTHER_ORG), keys).config.allowGeneratedLedgerKey).toBe(false);
  });

  it("keeps the platform settings it does not own", () => {
    const { config } = orgConfig(base, row(OTHER_ORG), keys);
    expect(config.database).toEqual(base.database);
    expect(config.llm).toEqual(base.llm);
    expect(config.compliance).toEqual(base.compliance);
    expect(config.clockMode).toBe(base.clockMode);
  });

  it("gives the retired public keys to the founding organization only", () => {
    expect(orgConfig(base, row(FOUNDING_ORG_ID), keys).config.ledgerRetiredPublicKeys).toBe(base.ledgerRetiredPublicKeys);
    expect(orgConfig(base, row(OTHER_ORG), keys).config.ledgerRetiredPublicKeys).toBeUndefined();
  });

  it("reports, and leaves unset, a secret sealed under a master key it does not hold", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem }, strangerKeys), keys);
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ledger_signing_key_enc");
    expect(warnings[0]).not.toContain(ledgerPem);
  });

  it("refuses a ciphertext moved from another organization's row", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { apiKey: "founding-key" }, keys, FOUNDING_ORG_ID), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(warnings[0]).toContain("circle_api_key_enc");
  });

  it("reports stored secrets it cannot open because no master key is configured", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem }), null);
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(warnings).toEqual(["ledger_signing_key_enc is stored, but VESTIARION_MASTER_KEYS is not set"]);
  });

  it("reports, and leaves unset, a stored secret when the configured master keys are malformed", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, { ledger: ledgerPem }), {
      unavailable: "VESTIARION_MASTER_KEYS entry 1 is not id:base64",
    });
    expect(config.ledgerSigningKey).toBeUndefined();
    expect(warnings).toEqual(["ledger_signing_key_enc is stored, but VESTIARION_MASTER_KEYS entry 1 is not id:base64"]);
    expect(warnings[0]).not.toContain(ledgerPem);
  });
});

describe("orgConfig — credentialsUnreadable (R12)", () => {
  // A stored Circle secret this deployment cannot open must not look like
  // "no Circle credentials configured" — that is sandbox mode, and it would
  // let getChainProvider() silently simulate a live organization's payments
  // instead of refusing to pay (spec §5.4).

  it("is set when the stored Circle API key cannot be decrypted", () => {
    const { config } = orgConfig(base, row(OTHER_ORG, { apiKey: "org-key" }, strangerKeys), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toContain("circle_api_key_enc");
  });

  it("is set when the stored Circle entity secret cannot be decrypted", () => {
    const { config } = orgConfig(base, row(OTHER_ORG, { entity: "org-secret" }, strangerKeys), keys);
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toContain("circle_entity_secret_enc");
  });

  it("is left unset for a row with no Circle credentials stored at all", () => {
    const { config } = orgConfig(base, row(OTHER_ORG), keys);
    expect(config.chain.credentialsUnreadable).toBeUndefined();
  });

  it("is left unset when the stored Circle credentials decrypt successfully", () => {
    const { config } = orgConfig(base, row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, keys), keys);
    expect(config.chain.circleApiKey).toBe("org-key");
    expect(config.chain.circleEntitySecret).toBe("org-secret");
    expect(config.chain.credentialsUnreadable).toBeUndefined();
  });
});
