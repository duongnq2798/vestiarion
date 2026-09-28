import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentConfig, currentOrgConfig, currentOrgId, currentSecretWarnings, currentUserId, runWith } from "@/lib/context";
import { FOUNDING_ORG_ID } from "@/lib/dal/org-config";
import { inOrg, withFoundingOrg, withOrg, withOrgSlug } from "@/lib/dal/scope";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const SEALED_ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000feed";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters" });

const sealingKeys = parseMasterKeys(`w1:${crypto.randomBytes(32).toString("base64")}`);
const sealedLedgerKey = "sealed-ledger-key-must-not-leak";

function orgRow(id: string, slug: string) {
  return { id, slug, name: `Org ${slug}`, mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

/** An organization row with a real envelope sealed under `sealingKeys`, for exercising the warnings wiring end to end. */
function sealedOrgRow() {
  return {
    id: SEALED_ORG,
    slug: "sealed",
    name: "Org sealed",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(sealedLedgerKey, { orgId: SEALED_ORG, column: "ledger_signing_key_enc" }, sealingKeys),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

function orgsTable(request: RecordedRequest) {
  if (request.path !== "/rest/v1/orgs") return { body: [] };
  const id = request.params.get("id")?.replace("eq.", "");
  const slug = request.params.get("slug")?.replace("eq.", "");
  if (id === ORG || slug === "northstar") return { body: orgRow(ORG, "northstar") };
  if (id === FOUNDING_ORG_ID) return { body: orgRow(FOUNDING_ORG_ID, "founding") };
  if (id === SEALED_ORG) return { body: sealedOrgRow() };
  return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
}

function inPlatform<T>(fn: () => Promise<T>) {
  const fake = fakeSupabase(orgsTable);
  return { fake, run: () => runWith({ config: base, db: fake.client, fetch: fake.fetch }, fn) };
}

describe("withOrg", () => {
  it("runs the work inside the organization, with its name as the business name", async () => {
    const { run } = inPlatform(() => withOrg(ORG, async () => [currentOrgId(), currentConfig().businessName, currentUserId()]));
    expect(await run()).toEqual([ORG, "Org northstar", undefined]);
  });

  it("reads the organization's row by id, and nothing else", async () => {
    const { fake, run } = inPlatform(() => withOrg(ORG, async () => null));
    await run();
    expect(fake.requests.map((request) => [request.path, request.params.get("id")])).toEqual([["/rest/v1/orgs", `eq.${ORG}`]]);
  });

  it("carries the user and the secret warnings into the scope", async () => {
    const { run } = inPlatform(() => withOrg(ORG, async () => [currentUserId(), currentSecretWarnings()], { userId: "user-1" }));
    expect(await run()).toEqual(["user-1", []]);
  });

  it("fails for an organization that does not exist, and runs nothing", async () => {
    let ran = false;
    const { run } = inPlatform(() => withOrg("5d0f3a2e-8c1b-4f7a-9e6d-000000000000", async () => { ran = true; }));
    await expect(run()).rejects.toThrow(/No organization with id/);
    expect(ran).toBe(false);
  });
});

describe("the other ways in", () => {
  it("withOrgSlug resolves the slug", async () => {
    const { run } = inPlatform(() => withOrgSlug("northstar", async () => currentOrgId()));
    expect(await run()).toBe(ORG);
  });

  it("withFoundingOrg names the founding organization", async () => {
    const { run } = inPlatform(() => withFoundingOrg(async () => currentOrgId()));
    expect(await run()).toBe(FOUNDING_ORG_ID);
  });

  it("inOrg takes what requireMembership and authorize return", async () => {
    const access = { user: { id: "user-2", email: null }, membership: { orgId: ORG } };
    const { run } = inPlatform(() => inOrg(access, async () => [currentOrgId(), currentUserId()]));
    expect(await run()).toEqual([ORG, "user-2"]);
  });
});

describe("nested scopes", () => {
  it("build the inner organization from the platform base, not from the outer organization's config", async () => {
    // Northstar's own config has no retired keys (only the founding chain has
    // ever rotated), so if the founding scope nested inside it inherited
    // Northstar's config instead of the platform base, this would see
    // `undefined` instead of the platform's retired keys (R7).
    const platformConfig = configFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
      LEDGER_RETIRED_PUBLIC_KEYS: "-----BEGIN PUBLIC KEY-----\nretired\n-----END PUBLIC KEY-----",
    });
    const fake = fakeSupabase(orgsTable);
    const result = await runWith({ config: platformConfig, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => withFoundingOrg(async () => currentConfig().ledgerRetiredPublicKeys))
    );
    expect(result).toBe(platformConfig.ledgerRetiredPublicKeys);
  });
});

describe("secret warnings from the environment's master keys", () => {
  const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
  afterEach(() => {
    if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
    else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  });

  it("warns and leaves the secret unset when VESTIARION_MASTER_KEYS is not set", async () => {
    delete process.env.VESTIARION_MASTER_KEYS;
    const { run } = inPlatform(() =>
      withOrg(SEALED_ORG, async () => [currentSecretWarnings(), currentOrgConfig().ledgerSigningKey])
    );
    expect(await run()).toEqual([["ledger_signing_key_enc is stored, but VESTIARION_MASTER_KEYS is not set"], undefined]);
  });

  it("opens the secret with no warning when set to the key it was sealed under", async () => {
    process.env.VESTIARION_MASTER_KEYS = `w1:${sealingKeys[0].key.toString("base64")}`;
    const { run } = inPlatform(() =>
      withOrg(SEALED_ORG, async () => [currentSecretWarnings(), currentOrgConfig().ledgerSigningKey])
    );
    expect(await run()).toEqual([[], sealedLedgerKey]);
  });

  it("warns instead of throwing when VESTIARION_MASTER_KEYS is set but malformed", async () => {
    process.env.VESTIARION_MASTER_KEYS = "not-an-id-colon-base64-entry";
    const { run } = inPlatform(() =>
      withOrg(SEALED_ORG, async () => [currentSecretWarnings(), currentOrgConfig().ledgerSigningKey] as const)
    );
    const [warnings, ledgerSigningKey] = await run();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ledger_signing_key_enc is stored, but");
    expect(warnings[0]).not.toContain(sealedLedgerKey);
    expect(ledgerSigningKey).toBeUndefined();
  });
});
