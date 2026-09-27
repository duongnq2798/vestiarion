import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentConfig, currentOrgId, currentSecretWarnings, currentUserId, runWith } from "@/lib/context";
import { FOUNDING_ORG_ID } from "@/lib/dal/org-config";
import { inOrg, withFoundingOrg, withOrg, withOrgSlug } from "@/lib/dal/scope";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function orgRow(id: string, slug: string) {
  return { id, slug, name: `Org ${slug}`, mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function orgsTable(request: RecordedRequest) {
  if (request.path !== "/rest/v1/orgs") return { body: [] };
  const id = request.params.get("id")?.replace("eq.", "");
  const slug = request.params.get("slug")?.replace("eq.", "");
  if (id === ORG || slug === "northstar") return { body: orgRow(ORG, "northstar") };
  if (id === FOUNDING_ORG_ID) return { body: orgRow(FOUNDING_ORG_ID, "founding") };
  return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
}

function inPlatform<T>(fn: () => Promise<T>) {
  const fake = fakeSupabase(orgsTable);
  return { fake, run: () => runWith({ config: base, db: fake.client }, fn) };
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
    await expect(run()).rejects.toThrow();
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

  it("inOrg takes what requireMembership and authorizeMutation return", async () => {
    const access = { user: { id: "user-2", email: null }, membership: { orgId: ORG } };
    const { run } = inPlatform(() => inOrg(access, async () => [currentOrgId(), currentUserId()]));
    expect(await run()).toEqual([ORG, "user-2"]);
  });
});
