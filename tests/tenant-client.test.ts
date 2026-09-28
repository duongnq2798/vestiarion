import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentContext, runWith } from "@/lib/context";
import { db, platformDb } from "@/lib/dal";
import { mintRequestToken } from "@/lib/dal/request-token";
import { tenantClient } from "@/lib/dal/tenant-client";
import { FOUNDING_ORG_ID } from "@/lib/dal/org-config";
import { withFoundingOrg, withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const SERVICE = "test-service-role-key-value";
const ANON = "test-anon-key-value";
const SECRET = "test-request-token-secret-at-least-32-characters";
const env = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: SERVICE, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_JWT_SECRET: SECRET };
const config = configFromEnv(env);

function claimsOf(request: RecordedRequest) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "null");
}

function orgRow(id: string, slug: string) {
  return { id, slug, name: slug, mode: "sandbox" as const, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

/** Answers whichever organization the request's `id` filter names, so a test that enters more than one org gets each one's own row. */
function orgsReply(request: RecordedRequest) {
  if (request.path !== "/rest/v1/orgs") return { body: [] };
  const id = request.params.get("id")?.replace(/^eq\./, "");
  return { body: id === FOUNDING_ORG_ID ? orgRow(FOUNDING_ORG_ID, "founding") : orgRow(ORG, "northstar") };
}

describe("tenantClient", () => {
  it("presents the anon key and a token for the organization, never the service role key", async () => {
    const fake = fakeSupabase();
    await tenantClient(config.database, ORG, "user-1", { fetch: fake.fetch }).from("invoices").select("id");
    const [request] = fake.requests;
    expect(request.headers.get("apikey")).toBe(ANON);
    expect(claimsOf(request)).toMatchObject({ role: "vestiarion_tenant", org_id: ORG, sub: "user-1" });
    expect(JSON.stringify([...request.headers])).not.toContain(SERVICE);
  });

  it("mints a fresh token for every request, so a long cycle never outlives one", async () => {
    const fake = fakeSupabase();
    let minted = 0;
    const mint: typeof mintRequestToken = (input) => { minted += 1; return mintRequestToken(input); };
    const client = tenantClient(config.database, ORG, undefined, { fetch: fake.fetch, mint });
    // supabase-js 2.117 also calls `accessToken` once while constructing, to
    // seed Realtime's auth; that token reaches no request, so count from here.
    const beforeRequests = minted;
    await client.from("invoices").select("id");
    await client.from("accounts").select("id");
    expect(minted - beforeRequests).toBe(2);
    expect(fake.requests.map((request) => claimsOf(request).org_id)).toEqual([ORG, ORG]);
  });

  it("refuses to exist without the token secret, naming it, rather than falling back", () => {
    expect(() => tenantClient({ ...config.database, requestTokenSecret: undefined }, ORG)).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("refuses to exist without the anon key, naming it", () => {
    expect(() => tenantClient({ ...config.database, anonKey: undefined }, ORG)).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
});

describe("a scope entered through the DAL", () => {
  it("sends tenant reads with the organization's token and platform reads with the service role", async () => {
    const fake = fakeSupabase(orgsReply);
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, async () => {
        await db().from("invoices").select("id");
      }, { userId: "user-2" })
    );
    const orgs = fake.requests.find((request) => request.path === "/rest/v1/orgs")!;
    const invoices = fake.requests.find((request) => request.path === "/rest/v1/invoices")!;
    // fakeSupabase() builds its service client with the key "test-service-role".
    expect(orgs.headers.get("authorization")).toBe("Bearer test-service-role");
    expect(claimsOf(invoices)).toMatchObject({ role: "vestiarion_tenant", org_id: ORG, sub: "user-2" });
    expect(invoices.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("keeps a nested scope's token separate from the outer scope's, in both directions", async () => {
    const fake = fakeSupabase(orgsReply);
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, async () => {
        await withFoundingOrg(async () => { await db().from("invoices").select("id"); });
        await db().from("invoices").select("id");
      }, { userId: "user-9" })
    );
    const [inner, outer] = fake.requests.filter((request) => request.path === "/rest/v1/invoices");
    expect(claimsOf(inner)).toMatchObject({ org_id: FOUNDING_ORG_ID, sub: "system" });
    expect(claimsOf(outer)).toMatchObject({ org_id: ORG, sub: "user-9" });
  });

  it("cannot be entered when the token secret is missing, and never reads the organization's row to find out", async () => {
    const fake = fakeSupabase(orgsReply);
    const broken = configFromEnv({ ...env, SUPABASE_JWT_SECRET: "" });
    await expect(runWith({ config: broken, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, async () => null))).rejects.toThrow(/SUPABASE_JWT_SECRET/);
    // A broken deployment fails on the setting it's missing, not partway
    // through work that setting would have been needed for — so the
    // organization's row (which decrypting its secrets would need) is never
    // even fetched.
    expect(fake.requests).toEqual([]);
  });

  it("keeps platformDb on the service role inside an organization", async () => {
    const fake = fakeSupabase(orgsReply);
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, async () => {
        await platformDb().from("memberships").select("role");
        expect(currentContext().tenantDb).toBeDefined();
      })
    );
    const memberships = fake.requests.find((request) => request.path === "/rest/v1/memberships")!;
    expect(memberships.headers.get("authorization")).toBe("Bearer test-service-role");
  });
});

describe("db()", () => {
  it("refuses a context without a tenant client instead of using the service role", async () => {
    const fake = fakeSupabase();
    await expect(runWith({ config, db: fake.client, orgId: ORG, platformConfig: config }, async () => db().from("invoices").select("id"))).rejects.toThrow(/tenant client/);
    expect(fake.requests).toEqual([]);
  });
});
