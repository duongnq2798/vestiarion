import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { runLiveOrganizations } from "@/lib/agent/cron";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

const A = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a000";
const B = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b000";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function orgRow(id: string, slug: string) {
  return { id, slug, name: `Org ${slug}`, mode: "live" as const, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

/** Two live organizations, plus the scope-entry read for either one by id. */
function liveOrgsDatabase(request: RecordedRequest): FakeReply {
  if (request.path !== "/rest/v1/orgs") return { body: [] };
  if (request.params.get("mode") === "eq.live") {
    return { body: [{ id: A, slug: "a-corp" }, { id: B, slug: "b-corp" }] };
  }
  const id = request.params.get("id")?.replace(/^eq\./, "");
  if (id === A) return { body: orgRow(A, "a-corp") };
  if (id === B) return { body: orgRow(B, "b-corp") };
  return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
}

describe("runLiveOrganizations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the work in every live organization, isolating each one's failure (spec §4.4)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(liveOrgsDatabase);
    const seen: string[] = [];
    const run = async () => {
      const orgId = currentOrgId();
      seen.push(orgId);
      if (orgId === B) throw new Error("boom");
      return "ok";
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: "ok" },
      { slug: "b-corp", ok: false, error: "boom" },
    ]);
    // Both ran, each entered its own scope: `run` saw each organization's own id.
    expect(seen).toEqual([A, B]);
    const orgsQuery = fake.requests.find((request) => request.path === "/rest/v1/orgs" && request.params.has("mode"));
    expect(orgsQuery?.params.get("mode")).toBe("eq.live");
    expect(console.error).toHaveBeenCalledWith("cycle failed for", "b-corp", expect.any(Error));
  });

  it("returns an empty result for no live organizations, without running anything", async () => {
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: [] } : { body: [] }));
    let ran = false;
    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      runLiveOrganizations(async () => { ran = true; })
    );
    expect(results).toEqual([]);
    expect(ran).toBe(false);
  });
});
