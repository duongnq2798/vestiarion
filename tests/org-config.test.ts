import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { FOUNDING_ORG_ID, ORG_SECRET_COLUMNS, orgConfig, retiredKeyBundle, type OrgRow } from "@/lib/dal/org-config";
import { ledgerKeyId, ledgerKeyring, ledgerReadKeys } from "@/lib/ledger-keys";
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

function row(
  orgId: string,
  sealed: Partial<Record<"ledger" | "apiKey" | "entity", string>> = {},
  sealWith = keys,
  sealFor = orgId,
  walletHost: OrgRow["wallet_host"] = null,
  ledgerRetiredKeys: unknown = []
): OrgRow {
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
    wallet_host: walletHost,
    ledger_retired_keys: ledgerRetiredKeys,
  };
}

/** A fresh Ed25519 public key, PEM-encoded, with the id its retired-key entry would carry. */
function retiredKeyItem(retiredAt = "2026-01-01T00:00:00Z") {
  const publicKeyPem = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  return { id: ledgerKeyId(crypto.createPublicKey(publicKeyPem)), publicKeyPem, retiredAt };
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

  it("gives the organization its network, and Arc testnet to a row from before 0075 (network foundation N1)", () => {
    expect(orgConfig(base, row(OTHER_ORG), keys).config.network).toBe("arc-testnet");
    expect(orgConfig(base, { ...row(OTHER_ORG), network: "arc-testnet" }, keys).config.network).toBe("arc-testnet");
    expect(orgConfig(base, { ...row(OTHER_ORG), network: "arc-mainnet" }, keys).config.network).toBe("arc-mainnet");
  });


  it("refuses a network it does not know rather than guess one", () => {
    expect(() => orgConfig(base, { ...row(OTHER_ORG), network: "arc-sepolia" as never }, keys)).toThrow('"arc-sepolia" is not a network Vestiarion knows');
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

describe("orgConfig — the USYC reserve (USYC live design R1)", () => {
  it("is real only for a live workspace whose owner turned it on", () => {
    const live = { ...row(FOUNDING_ORG_ID), mode: "live" as const };
    expect(orgConfig(base, { ...live, usyc_live_at: "2026-10-02T04:00:00Z" }, keys).config.chain.usycLive).toBe(true);
    expect(orgConfig(base, { ...live, usyc_live_at: null }, keys).config.chain.usycLive).toBe(false);
    expect(orgConfig(base, { ...live, mode: "sandbox", usyc_live_at: "2026-10-02T04:00:00Z" }, keys).config.chain.usycLive).toBe(false);
  });

  it("is read with the rest of the row", () => {
    expect(ORG_SECRET_COLUMNS).toContain("usyc_live_at");
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

describe("orgConfig — hosted wallets (H1, H7; Review Focus 1 and 5)", () => {
  // The hosted pair is given only to a workspace whose own row says
  // wallet_host = 'hosted'. It is never a fallback: an own-account workspace
  // (or one that has not chosen) whose own credentials are missing or
  // unreadable must never pay with it.
  const HOSTED_KEY = "hosted-circle-key";
  const HOSTED_SECRET = "hosted-circle-secret";
  const hostedBase = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    CIRCLE_API_KEY: "env-circle-key",
    CIRCLE_ENTITY_SECRET: "env-circle-secret",
    HOSTED_CIRCLE_API_KEY: HOSTED_KEY,
    HOSTED_CIRCLE_ENTITY_SECRET: HOSTED_SECRET,
  });
  const noHostedPair = { ...hostedBase, chain: { ...hostedBase.chain, hostedCircleApiKey: undefined, hostedCircleEntitySecret: undefined } };
  const NOT_CONFIGURED = "the hosted Circle account is not configured on this deployment";

  /** Ruling R4: an organization that is not hosted carries the platform pair under no key at all. */
  const expectNoHostedPair = (config: VestiarionConfig) => {
    expect(config.chain.circleApiKey).not.toBe(HOSTED_KEY);
    expect(config.chain.circleEntitySecret).not.toBe(HOSTED_SECRET);
    const text = JSON.stringify(config);
    expect(text).not.toContain(HOSTED_KEY);
    expect(text).not.toContain(HOSTED_SECRET);
  };

  /** Ruling R4: every organization's chain config drops the platform pair's own keys. */
  const expectPairKeysStripped = (config: VestiarionConfig) => {
    expect(Object.keys(config.chain)).not.toContain("hostedCircleApiKey");
    expect(Object.keys(config.chain)).not.toContain("hostedCircleEntitySecret");
  };

  const occurrences = (text: string, value: string) => text.split(value).length - 1;

  it("own: an own-account workspace uses its own credentials, not the hosted pair", () => {
    const { config, warnings } = orgConfig(hostedBase, row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, keys, OTHER_ORG, "own"), keys);
    expect(warnings).toEqual([]);
    expect(config.chain.circleApiKey).toBe("org-key");
    expect(config.chain.circleEntitySecret).toBe("org-secret");
    expect(config.chain.credentialsUnreadable).toBeUndefined();
  });

  it("own-missing: an own-account workspace with no credentials gets none, not the hosted pair", () => {
    const { config, warnings } = orgConfig(hostedBase, row(OTHER_ORG, {}, keys, OTHER_ORG, "own"), keys);
    expect(warnings).toEqual([]);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBeUndefined();
  });

  it("own-unreadable: an own-account workspace whose credentials cannot be opened refuses, and never gets the hosted pair", () => {
    const { config } = orgConfig(
      hostedBase, row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, strangerKeys, OTHER_ORG, "own"), keys
    );
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toContain("circle_api_key_enc");
    expectNoHostedPair(config);
  });

  it("own-unreadable: the same with no master keys at all", () => {
    const { config } = orgConfig(hostedBase, row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, keys, OTHER_ORG, "own"), null);
    expect(config.chain.credentialsUnreadable).toBeDefined();
    expectNoHostedPair(config);
  });

  it("hosted: a hosted workspace gets the platform's hosted pair", () => {
    const { config, warnings } = orgConfig(hostedBase, row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), keys);
    expect(warnings).toEqual([]);
    expect(config.chain.circleApiKey).toBe(HOSTED_KEY);
    expect(config.chain.circleEntitySecret).toBe(HOSTED_SECRET);
    expect(config.chain.credentialsUnreadable).toBeUndefined();
    // Never the platform's own (founding) Circle pair.
    expect(config.chain.circleApiKey).not.toBe("env-circle-key");
  });

  it("hosted: the hosted pair replaces any credentials stored on the row, which are not opened", () => {
    const { config, warnings } = orgConfig(
      hostedBase, row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, strangerKeys, OTHER_ORG, "hosted"), keys
    );
    expect(config.chain.circleApiKey).toBe(HOSTED_KEY);
    expect(config.chain.circleEntitySecret).toBe(HOSTED_SECRET);
    expect(config.chain.credentialsUnreadable).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("hosted: the hosted pair is used even when the master keys are missing, since nothing is sealed", () => {
    const { config } = orgConfig(hostedBase, row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), null);
    expect(config.chain.circleApiKey).toBe(HOSTED_KEY);
    expect(config.chain.credentialsUnreadable).toBeUndefined();
  });

  it("hosted-missing: a hosted workspace on a deployment without the hosted pair refuses to pay, never simulates", () => {
    const { config, warnings } = orgConfig(noHostedPair, row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe(NOT_CONFIGURED);
    expect(warnings).toEqual([NOT_CONFIGURED]);
  });

  it("hosted-missing: half a hosted pair is as good as none", () => {
    for (const half of [
      { ...hostedBase, chain: { ...hostedBase.chain, hostedCircleApiKey: undefined } },
      { ...hostedBase, chain: { ...hostedBase.chain, hostedCircleEntitySecret: undefined } },
    ]) {
      const { config, warnings } = orgConfig(half, row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), keys);
      expect(config.chain.circleApiKey).toBeUndefined();
      expect(config.chain.circleEntitySecret).toBeUndefined();
      expect(config.chain.credentialsUnreadable).toBe(NOT_CONFIGURED);
      expect(warnings).toEqual([NOT_CONFIGURED]);
    }
  });

  it("hosted: the warning names no secret", () => {
    const { warnings } = orgConfig(
      { ...hostedBase, chain: { ...hostedBase.chain, hostedCircleEntitySecret: undefined } },
      row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"),
      keys
    );
    expect(JSON.stringify(warnings)).not.toContain(HOSTED_KEY);
    expect(JSON.stringify(warnings)).not.toContain("env-circle");
  });

  it("null: a workspace that has not chosen never gets the hosted pair", () => {
    for (const orgId of [OTHER_ORG, FOUNDING_ORG_ID]) {
      const { config } = orgConfig(hostedBase, row(orgId, {}, keys, orgId, null), keys);
      expect(config.chain.circleApiKey).toBeUndefined();
      expect(config.chain.circleEntitySecret).toBeUndefined();
      expect(config.chain.credentialsUnreadable).toBeUndefined();
    }
  });

  it("null: nor when its own credentials cannot be read", () => {
    const { config } = orgConfig(hostedBase, row(OTHER_ORG, { apiKey: "org-key" }, strangerKeys, OTHER_ORG, null), keys);
    expect(config.chain.credentialsUnreadable).toContain("circle_api_key_enc");
    expectNoHostedPair(config);
  });

  it("null: a row read without the column at all is treated as not hosted", () => {
    const legacy = { ...row(OTHER_ORG), wallet_host: undefined } as unknown as OrgRow;
    const { config } = orgConfig(hostedBase, legacy, keys);
    expectNoHostedPair(config);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.walletHost).toBeNull();
  });

  describe("ruling R4: the platform pair is stripped, and only a boolean says it exists", () => {
    const cases = [
      ["own, with credentials", row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, keys, OTHER_ORG, "own")],
      ["own, without credentials", row(OTHER_ORG, {}, keys, OTHER_ORG, "own")],
      ["own, credentials unreadable", row(OTHER_ORG, { apiKey: "org-key", entity: "org-secret" }, strangerKeys, OTHER_ORG, "own")],
      ["not chosen", row(OTHER_ORG, {}, keys, OTHER_ORG, null)],
      ["the founding workspace", row(FOUNDING_ORG_ID, { apiKey: "org-key", entity: "org-secret" }, keys, FOUNDING_ORG_ID, null)],
    ] as const;

    it.each(cases)("%s: the config contains the pair under no key, and says hostedAvailable", (_label, org) => {
      const { config, warnings } = orgConfig(hostedBase, org, keys);
      expectNoHostedPair(config);
      expectPairKeysStripped(config);
      expect(JSON.stringify(warnings)).not.toContain(HOSTED_KEY);
      expect(config.chain.hostedAvailable).toBe(true);
    });

    it.each(cases)("%s: hostedAvailable is false on a deployment without the pair", (_label, org) => {
      const { config } = orgConfig(noHostedPair, org, keys);
      expectPairKeysStripped(config);
      expect(config.chain.hostedAvailable).toBe(false);
    });

    it("hosted: the pair appears once each, as circleApiKey and circleEntitySecret only", () => {
      const { config } = orgConfig(hostedBase, row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), keys);
      expectPairKeysStripped(config);
      const text = JSON.stringify(config);
      expect(occurrences(text, HOSTED_KEY)).toBe(1);
      expect(occurrences(text, HOSTED_SECRET)).toBe(1);
      expect(config.chain.circleApiKey).toBe(HOSTED_KEY);
      expect(config.chain.circleEntitySecret).toBe(HOSTED_SECRET);
      expect(config.chain.hostedAvailable).toBe(true);
    });

    it("half a pair is not available", () => {
      for (const half of [
        { ...hostedBase, chain: { ...hostedBase.chain, hostedCircleApiKey: undefined } },
        { ...hostedBase, chain: { ...hostedBase.chain, hostedCircleEntitySecret: undefined } },
      ]) {
        const { config } = orgConfig(half, row(OTHER_ORG, {}, keys, OTHER_ORG, null), keys);
        expect(config.chain.hostedAvailable).toBe(false);
        expectPairKeysStripped(config);
        expectNoHostedPair(config);
      }
    });

    it("hostedAvailable is a boolean and nothing more", () => {
      const { config } = orgConfig(hostedBase, row(OTHER_ORG), keys);
      expect(typeof config.chain.hostedAvailable).toBe("boolean");
    });

    it.each([
      ["own", "own"],
      ["hosted", "hosted"],
      ["not chosen", null],
    ] as const)("%s: walletHost carries the row's wallet_host, for provisioning to name the wallet set", (_label, host) => {
      const { config } = orgConfig(hostedBase, row(OTHER_ORG, {}, keys, OTHER_ORG, host), keys);
      expect(config.chain.walletHost).toBe(host);
    });

    it("the platform config the scope was built from is not changed", () => {
      const before = structuredClone(hostedBase);
      orgConfig(hostedBase, row(OTHER_ORG, {}, keys, OTHER_ORG, "own"), keys);
      expect(hostedBase).toEqual(before);
    });
  });
});

describe("orgConfig — a workspace's own retired ledger keys", () => {
  it("gives a non-founding organization the PEMs from its own retired-keys column", () => {
    const item1 = retiredKeyItem("2026-01-01T00:00:00Z");
    const item2 = retiredKeyItem("2026-02-01T00:00:00Z");
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, {}, keys, OTHER_ORG, null, [item1, item2]), keys);
    expect(warnings).toEqual([]);
    expect(config.ledgerRetiredPublicKeys).toBe(`${item1.publicKeyPem}\n${item2.publicKeyPem}`);
    const keyring = ledgerKeyring(config);
    expect(keyring.retired.map((k) => ledgerKeyId(k)).sort()).toEqual([item1.id, item2.id].sort());
  });

  it("gives a non-founding organization with no retired keys undefined", () => {
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, {}, keys, OTHER_ORG, null, []), keys);
    expect(warnings).toEqual([]);
    expect(config.ledgerRetiredPublicKeys).toBeUndefined();
  });

  it("gives the founding organization both the environment bundle and its column bundle", () => {
    const item = retiredKeyItem();
    const { config, warnings } = orgConfig(base, row(FOUNDING_ORG_ID, {}, keys, FOUNDING_ORG_ID, null, [item]), keys);
    expect(warnings).toEqual([]);
    expect(config.ledgerRetiredPublicKeys).toBe(`${base.ledgerRetiredPublicKeys}\n${item.publicKeyPem}`);
  });

  it("skips a malformed retired-key entry, names it in warnings, and still loads the good ones", () => {
    const good = retiredKeyItem();
    const privatePem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const malformed = [{ id: 1 }, { id: "priv", publicKeyPem: privatePem, retiredAt: "2026-01-01T00:00:00Z" }, "not-an-object", good];
    const { config, warnings } = orgConfig(base, row(OTHER_ORG, {}, keys, OTHER_ORG, null, malformed), keys);
    expect(config.ledgerRetiredPublicKeys).toBe(good.publicKeyPem);
    expect(warnings).toEqual([
      "ledger_retired_keys entry 1 is not a public key; skipped",
      "ledger_retired_keys entry 2 is not a public key; skipped",
      "ledger_retired_keys entry 3 is not a public key; skipped",
    ]);
  });

  it("ORG_SECRET_COLUMNS selects ledger_retired_keys", () => {
    expect(ORG_SECRET_COLUMNS).toContain("ledger_retired_keys");
  });
});

describe("retiredKeyBundle", () => {
  it("joins well-formed items' PEMs with a newline", () => {
    const item1 = retiredKeyItem();
    const item2 = retiredKeyItem();
    const warnings: string[] = [];
    expect(retiredKeyBundle([item1, item2], warnings)).toBe(`${item1.publicKeyPem}\n${item2.publicKeyPem}`);
    expect(warnings).toEqual([]);
  });

  it("returns undefined for an empty array", () => {
    const warnings: string[] = [];
    expect(retiredKeyBundle([], warnings)).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("retiredKeyBundle — only a readable public key reaches the keyring (final review, minor 3)", () => {
  const good = retiredKeyItem();
  const privatePem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const truncated = good.publicKeyPem.slice(0, good.publicKeyPem.indexOf("-----END"));
  const publicThenPrivate = `${retiredKeyItem().publicKeyPem}\n${privatePem}`;
  const garbage = "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5IGF0IGFsbCwganVzdCBiYXNlNjQ=\n-----END PUBLIC KEY-----\n";

  it.each([
    ["a truncated PEM", truncated],
    ["a PUBLIC block followed by a PRIVATE block", publicThenPrivate],
    ["a PUBLIC header around garbage base64", garbage],
  ])("skips %s with the usual warning, and still loads the good item beside it", (_label, publicKeyPem) => {
    const bad = { id: "badbadbadbadbadb", publicKeyPem, retiredAt: "2026-01-01T00:00:00Z" };
    const warnings: string[] = [];
    const bundle = retiredKeyBundle([bad, good], warnings);
    // Compared as booleans, so a failure never prints the private block into test output.
    expect(bundle?.includes("PRIVATE KEY"), "the bundle holds a private block").toBe(false);
    expect(bundle === good.publicKeyPem, "the bundle is exactly the good item's PEM").toBe(true);
    expect(warnings).toEqual(["ledger_retired_keys entry 1 is not a public key; skipped"]);

    const { config } = orgConfig(base, row(OTHER_ORG, {}, keys, OTHER_ORG, null, [bad, good]), keys);
    const readKeys = ledgerReadKeys(config);
    expect(readKeys.warnings).toEqual([]);
    expect(readKeys.retired.map((key) => ledgerKeyId(key))).toEqual([good.id]);
  });
});

describe("orgConfig — screening by workspace mode (docs/superpowers/specs/2026-10-03-sandbox-screening-design.md)", () => {
  const screened = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    OPENSANCTIONS_API_URL: "https://api.opensanctions.example",
    OPENSANCTIONS_API_KEY: "os-key-must-stay-with-live-workspaces",
    COMPLIANCE_RESCREEN_HOURS: "720",
  });

  it("keeps the screening service for a live workspace, as the platform configures it", () => {
    const { config } = orgConfig(screened, { ...row(OTHER_ORG), mode: "live" }, keys);
    expect(config.compliance).toEqual(screened.compliance);
    expect(config.compliance.openSanctionsUrl).toBe("https://api.opensanctions.example");
  });

  it("screens a sandbox against the bundled list: no service, no key, and again every cycle, since it costs nothing", () => {
    const { config } = orgConfig(screened, { ...row(OTHER_ORG), mode: "sandbox" }, keys);
    expect(config.compliance.openSanctionsUrl).toBeUndefined();
    expect(config.compliance.openSanctionsApiKey).toBeUndefined();
    expect(config.compliance.rescreenIntervalHours).toBe(0);
    expect(JSON.stringify(config)).not.toContain("os-key-must-stay-with-live-workspaces");
  });

  it("requires the screening service of a live workspace on a deployment without one, so the demo list never clears its counterparties (payment safety K1)", () => {
    const { config } = orgConfig(base, { ...row(OTHER_ORG), mode: "live" }, keys);
    expect(config.compliance).toEqual({ ...base.compliance, serviceRequired: true });
  });

  it("changes nothing for a sandbox when no screening service is configured", () => {
    const { config } = orgConfig(base, { ...row(OTHER_ORG), mode: "sandbox" }, keys);
    expect(config.compliance).toEqual(base.compliance);
  });
});

describe("a workspace on Arc mainnet (mainnet go-live M4, M5)", () => {
  const sealed = { apiKey: "LIVE_API_KEY:org-key", entity: "org-secret" };
  const mainnet = (mode: "sandbox" | "live", withKeys = true): OrgRow => ({ ...row(OTHER_ORG, withKeys ? sealed : {}), mode, network: "arc-mainnet" });
  const on = { ...base, mainnetEnabled: true };

  it("gets no Circle credentials while the deployment has Arc mainnet off, and is held with the reason", () => {
    const { config, warnings } = orgConfig(base, mainnet("live"), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe("Arc mainnet is switched off on this deployment.");
    expect(config.chain.networkHold).toBe("Arc mainnet is switched off on this deployment.");
    expect(warnings).toContain("Arc mainnet is switched off on this deployment.");
  });

  it("opens its own credentials once Arc mainnet is on, and holds it until it is live", () => {
    const sandbox = orgConfig(on, mainnet("sandbox"), keys).config;
    expect(sandbox.chain.circleApiKey).toBe("LIVE_API_KEY:org-key");
    expect(sandbox.chain.circleEntitySecret).toBe("org-secret");
    expect(sandbox.chain.credentialsUnreadable).toBeUndefined();
    expect(sandbox.chain.networkHold).toBe("This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.");
    const live = orgConfig(on, mainnet("live"), keys).config;
    expect(live.chain.circleApiKey).toBe("LIVE_API_KEY:org-key");
    expect(live.chain.networkHold).toBeUndefined();
  });

  it("with no Circle account connected, has nothing stored that could not be read, and no warning", () => {
    const { config, warnings } = orgConfig(on, mainnet("sandbox", false), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("keeps a stored credential it could not open reported as such, not as unconnected", () => {
    const { config } = orgConfig(on, { ...row(OTHER_ORG, sealed, strangerKeys), mode: "live", network: "arc-mainnet" }, keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBeTruthy();
    expect(config.chain.credentialsUnreadable).not.toBe("Arc mainnet is switched off on this deployment.");
  });

  it("never takes the platform's hosted testnet pair", () => {
    const hostedBase = { ...on, chain: { ...on.chain, hostedCircleApiKey: "TEST_API_KEY:hosted", hostedCircleEntitySecret: "hosted-secret" } };
    const { config } = orgConfig(hostedBase, { ...row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), network: "arc-mainnet" }, keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe("A hosted wallet does not run on Arc mainnet yet");
  });

  it("leaves a testnet workspace exactly as before, whether or not Arc mainnet is on", () => {
    for (const platform of [base, on]) {
      const { config } = orgConfig(platform, row(OTHER_ORG, sealed), keys);
      expect(config.chain.circleApiKey).toBe("LIVE_API_KEY:org-key");
      expect(config.chain.networkHold).toBeUndefined();
      expect(config.chain.credentialsUnreadable).toBeUndefined();
    }
  });
});
