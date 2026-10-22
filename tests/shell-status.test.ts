import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { lastLiveSuccessLine } from "@/lib/screening/health";
import { shellStatus } from "@/lib/shell-status";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a workspace page's header reads in the workspace's scope (workspace shell design S5), and the newest live check
 * beside it (docs/superpowers/specs/2026-10-22-screening-health-design.md SH4): one `limit 1` query on the workspace's
 * live checks, run with the shadow mode read and only where screening is live. And the Compliance page's last successful
 * live screening (SH3), from the same rows. Live lookups of the provider only, the workspace's own only: a verdict on a
 * payout address on OFAC's list is written as live but calls no provider, so it says nothing about the key.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000005c01";
const BASE = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };
const LIVE = configFromEnv({ ...BASE, OPENSANCTIONS_API_URL: "https://api.opensanctions.org", OPENSANCTIONS_API_KEY: "sk-test" });
const SANDBOX = configFromEnv(BASE);

type Responder = (request: RecordedRequest) => FakeReply;

function workspace(config: typeof LIVE, checks: Responder, shadow: unknown[] = []) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/shadow_modes") return { body: shadow };
    if (request.path === "/rest/v1/compliance_checks") return checks(request);
    return { status: 500, body: { message: `${request.path} is not read here` } };
  });
  const context = orgTestContext({ config, client: fake.client, orgId: ORG });
  return { requests: fake.requests, run: <T,>(fn: () => Promise<T>) => runWith(context, fn) };
}

const checkReads = (requests: RecordedRequest[]) => requests.filter((request) => request.path === "/rest/v1/compliance_checks");

type LiveRow = { status: "complete" | "failed"; created_at: string; source: string };

/**
 * Answers from the workspace's own live checks as PostgREST would: the `status` and `source` filters the read sends,
 * newest first, its limit and its columns. A filter it does not know fails the test rather than being ignored.
 */
function liveChecks(rows: LiveRow[]): Responder {
  return (request) => {
    const keep = (row: LiveRow, column: "status" | "source") => {
      const filter = request.params.get(column);
      if (filter === null) return true;
      if (filter.startsWith("eq.")) return row[column] === filter.slice(3);
      if (filter.startsWith("neq.")) return row[column] !== filter.slice(4);
      throw new Error(`unexpected filter ${column}=${filter}`);
    };
    const columns = (request.params.get("select") ?? "").split(",") as Array<keyof LiveRow>;
    const matched = rows
      .filter((row) => keep(row, "status") && keep(row, "source"))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, Number(request.params.get("limit") ?? rows.length));
    return { body: matched.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))) };
  };
}

// A provider lookup that worked, one that failed after it, and a verdict on an address on OFAC's list newer than both.
const PROVIDER_OK: LiveRow = { status: "complete", created_at: "2026-10-22T11:40:00Z", source: "opensanctions:yente" };
const PROVIDER_FAILED: LiveRow = { status: "failed", created_at: "2026-10-30T06:17:00Z", source: "opensanctions:yente" };
const ADDRESS_VERDICT: LiveRow = { status: "complete", created_at: "2026-10-30T09:05:00Z", source: "ofac-sdn" };

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the header's screening fact, read in scope (SH4)", () => {
  it("says the newest live lookup failed, from one limit-1 read of the workspace's own live checks", async () => {
    const { requests, run } = workspace(LIVE, () => ({ body: [{ status: "failed", created_at: "2026-10-30T06:17:00Z" }] }));
    expect(await run(() => shellStatus())).toEqual({ shadow: false, screening: { live: true, source: "OpenSanctions", lastLookupFailed: true } });
    const [read] = checkReads(requests);
    expect(checkReads(requests)).toHaveLength(1);
    expect(read.method).toBe("GET");
    expect(Object.fromEntries(read.params)).toEqual({
      select: "status,created_at",
      org_id: `eq.${ORG}`,
      screening_mode: "eq.live",
      source: "neq.ofac-sdn",
      order: "created_at.desc",
      limit: "1",
    });
  });

  it("still says the last lookup failed when a verdict on an address on OFAC's list is newer", async () => {
    const { requests, run } = workspace(LIVE, liveChecks([PROVIDER_OK, PROVIDER_FAILED, ADDRESS_VERDICT]));
    expect((await run(() => shellStatus())).screening).toEqual({ live: true, source: "OpenSanctions", lastLookupFailed: true });
    expect(checkReads(requests)[0].params.get("source")).toBe("neq.ofac-sdn");
  });

  it("stays Live when the newest live lookup succeeded, or there is none yet", async () => {
    const ok = workspace(LIVE, () => ({ body: [{ status: "complete", created_at: "2026-10-22T11:40:00Z" }] }));
    expect((await ok.run(() => shellStatus())).screening).toEqual({ live: true, source: "OpenSanctions", lastLookupFailed: false });
    const none = workspace(LIVE, () => ({ body: [] }));
    expect((await none.run(() => shellStatus())).screening).toEqual({ live: true, source: "OpenSanctions", lastLookupFailed: false });
  });

  it("reads no check at all where screening is not live", async () => {
    const { requests, run } = workspace(SANDBOX, () => ({ body: [{ status: "failed", created_at: "2026-10-22T11:40:00Z" }] }));
    expect((await run(() => shellStatus())).screening).toEqual({ live: false, source: "bundled list", lastLookupFailed: false });
    expect(checkReads(requests)).toEqual([]);
  });

  it("keeps the configured fact when the newest check cannot be read, and shadow mode apart from it", async () => {
    const { run } = workspace(LIVE, () => ({ status: 500, body: { message: "boom" } }), [{ currency: "USDC", started_at: "2026-10-01T00:00:00Z", started_by: null }]);
    expect(await run(() => shellStatus())).toEqual({ shadow: true, screening: { live: true, source: "OpenSanctions", lastLookupFailed: false } });
    expect(errors).toHaveBeenCalledWith("shell status: newest live check not read", expect.stringContaining("boom"));
  });
});

describe("the Compliance page's last successful live screening (SH3)", () => {
  it("reads the workspace's newest complete live check", async () => {
    const { requests, run } = workspace(LIVE, () => ({ body: [{ created_at: "2026-10-22T11:40:00Z" }] }));
    expect(await run(() => lastLiveSuccessLine(db()))).toBe("Last successful live screening: Oct 22, 2026, 11:40 UTC");
    expect(Object.fromEntries(checkReads(requests)[0].params)).toEqual({
      select: "created_at",
      org_id: `eq.${ORG}`,
      screening_mode: "eq.live",
      source: "neq.ofac-sdn",
      status: "eq.complete",
      order: "created_at.desc",
      limit: "1",
    });
  });

  it("gives the last provider lookup that worked, not a newer verdict on an address on OFAC's list", async () => {
    const { run } = workspace(LIVE, liveChecks([PROVIDER_OK, PROVIDER_FAILED, ADDRESS_VERDICT]));
    expect(await run(() => lastLiveSuccessLine(db()))).toBe("Last successful live screening: Oct 22, 2026, 11:40 UTC");
    // An address verdict alone is no lookup that worked.
    const verdictOnly = workspace(LIVE, liveChecks([PROVIDER_FAILED, ADDRESS_VERDICT]));
    expect(await verdictOnly.run(() => lastLiveSuccessLine(db()))).toBe("Last successful live screening: none yet");
  });

  it("says none yet, and says so when it could not be read rather than none", async () => {
    expect(await workspace(LIVE, () => ({ body: [] })).run(() => lastLiveSuccessLine(db()))).toBe("Last successful live screening: none yet");
    expect(await workspace(LIVE, () => ({ status: 500, body: { message: "boom" } })).run(() => lastLiveSuccessLine(db()))).toBe(
      "Last successful live screening: could not be read"
    );
  });
});
