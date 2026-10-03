import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/milestones/route";
import { operationById } from "@/lib/api/openapi";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { carriesOrg, fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `POST /api/v1/milestones` (docs/superpowers/specs/2026-10-03-write-api-part-2-design.md W1, W2, W6): a read-and-write
 * key adds work a contractor is to be paid for, through the same `addMilestone` the console's form runs, as its
 * issuer's. It starts pending: the API cannot verify it. A body that does not validate is answered with 400, naming the
 * field, before anything is written or remembered; a contractor the workspace does not hold, or a client, is answered
 * with 400 once the write has started, and that answer is remembered for its `Idempotency-Key`.
 */

const { cycleMock } = vi.hoisted(() => ({ cycleMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: cycleMock, raiseCycleEvent: vi.fn() }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const CONTRACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c11e";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";
const PULL_REQUEST = "https://github.com/acme/widgets/pull/42";
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
};
const orgs = signedOrgs();
let keyCounter = 0;
let key: AuthenticatedKey;

/** A fresh key per test, so the per-key write limit never carries over. */
function useKey() {
  keyCounter += 1;
  key = { keyId: `4d4d4d4d-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`, orgId: ORG, scopes: ["read", "write"], createdBy: ISSUER };
  vi.mocked(authenticateApiKey).mockResolvedValue(key);
}

beforeEach(() => {
  cycleMock.mockReset();
  vi.mocked(authenticateApiKey).mockReset();
  useKey();
});

const STORED = {
  id: MILESTONE, title: "Fix the EURC import", amount: "0.10", status: "pending", verification_source: PULL_REQUEST,
  verification_method: "unverified", verification_status: "unverified", verification_checked_at: null, verified_at: null,
  verification_detail: {}, verified: false, decided_at: null, settled_at: null, closed_at: null, close_reason: null,
  agent_reasoning: null, tx_ref: null, created_at: "2026-10-03T15:00:00Z",
  counterparties: { id: CONTRACTOR, name: "Linh Nguyen", risk_level: "clear" },
};

interface Options {
  githubToken?: string;
  role?: string;
  /** What `api_idempotency` already holds for the key, as a repeat finds it. */
  stored?: { request_hash: string; status: number; response: unknown };
}

function workspace(options: Options = {}) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/memberships") return { body: [{ role: options.role ?? "admin" }] };
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { mode: "live" }) };
    if (sent.path === "/rest/v1/counterparties") {
      const rows = [
        { id: CONTRACTOR, name: "Linh Nguyen", role: "contractor" },
        { id: CLIENT, name: "Lumen Retail", role: "client" },
      ];
      return { body: rows.filter((row) => sent.params.get("id") === `eq.${row.id}`) };
    }
    if (sent.path === "/rest/v1/milestones" && sent.method === "POST") return { body: { id: MILESTONE } };
    if (sent.path === "/rest/v1/milestones" && sent.method === "GET") return { body: STORED };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "POST") {
      return { status: 201, body: options.stored ? [] : [{ org_id: ORG }] };
    }
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "GET" && options.stored) {
      return { body: [{ ...options.stored, created_at: new Date().toISOString() }] };
    }
    return { body: [] };
  });
  const config = configFromEnv(options.githubToken ? { ...ENV, GITHUB_TOKEN: options.githubToken } : ENV);
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      POST(
        new Request("https://vestiarion.invalid/api/v1/milestones", {
          method: "POST",
          headers: { authorization: "Bearer vxk_test", "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        })
      )
    );
  return { fake, send };
}

const valid = { contractorId: CONTRACTOR, title: "Fix the EURC import", amount: "0.10", verificationSource: `${PULL_REQUEST}/` };
const requestsTo = (requests: RecordedRequest[], path: string) => requests.filter((sent) => sent.path === path);
const milestoneInsert = (requests: RecordedRequest[]) =>
  requestsTo(requests, "/rest/v1/milestones").find((sent) => sent.method === "POST")?.body as Record<string, unknown> | undefined;
const ledgerDetail = (requests: RecordedRequest[]) =>
  (requestsTo(requests, "/rest/v1/rpc/append_ledger_entry")[0]?.body as { p_detail: Record<string, unknown> } | undefined)?.p_detail;

describe("POST /api/v1/milestones", () => {
  it("adds the milestone pending, as the issuer's, and answers 201 with it, shaped as the list returns it", async () => {
    const { fake, send } = workspace();
    const response = await send(valid);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(operationById("create-milestone")!.response.parse(body)).toEqual(body);
    expect(body.data).toMatchObject({ id: MILESTONE, status: "pending", verified: false, verificationSource: PULL_REQUEST, amount: 0.1 });
    expect(milestoneInsert(fake.requests)).toEqual({
      org_id: ORG,
      contractor_id: CONTRACTOR,
      title: "Fix the EURC import",
      amount: "0.10",
      verification_source: PULL_REQUEST,
      created_by: ISSUER,
    });
    const readBack = requestsTo(fake.requests, "/rest/v1/milestones").find((sent) => sent.method === "GET");
    expect(readBack?.params.get("id")).toBe(`eq.${MILESTONE}`);
    expect(ledgerDetail(fake.requests)).toMatchObject({ by: ISSUER, milestoneId: MILESTONE, via: "api", apiKeyId: key.keyId });
  });

  it("has the agent check a pull request within a minute when a GitHub token is configured, and not otherwise", async () => {
    await workspace({ githubToken: "github-read-token" }).send(valid);
    expect(cycleMock).toHaveBeenCalledWith({ orgId: ORG, userId: ISSUER, sandbox: false, kind: "milestone_added" });

    cycleMock.mockReset();
    useKey();
    await workspace().send(valid);
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("takes a number for the amount, and no link at all", async () => {
    const { fake, send } = workspace();
    expect((await send({ contractorId: CONTRACTOR, title: "Logo", amount: 12.5 })).status).toBe(201);
    expect(milestoneInsert(fake.requests)).toMatchObject({ amount: "12.5", verification_source: null });
  });

  it.each([
    ["a contractor the workspace does not hold", "0b6c1c9e-4a4f-4a7e-9b1e-00000000dead", "contractorId: No counterparty with this id in this workspace."],
    ["a client, who is not paid for milestones", CLIENT, "contractorId: A client is not paid for milestones. Use a contractor or a vendor."],
  ])("answers 400 to %s, adds nothing, and remembers the answer under its Idempotency-Key", async (_label, contractorId, message) => {
    const { fake, send } = workspace();
    const response = await send({ ...valid, contractorId }, { "idempotency-key": "ci-bounty-pr-42" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message } });
    const [lookup] = requestsTo(fake.requests, "/rest/v1/counterparties");
    expect(carriesOrg(lookup, ORG)).toBe(true);
    expect(milestoneInsert(fake.requests)).toBeUndefined();
    expect(ledgerDetail(fake.requests)).toBeUndefined();
    const stored = requestsTo(fake.requests, "/rest/v1/api_idempotency").find((sent) => sent.method === "PATCH");
    expect(stored?.body).toMatchObject({ status: 400 });
  });

  it.each([
    ["a field the API does not take", { ...valid, evidence: PULL_REQUEST }, "evidence: is not a field this operation takes."],
    ["a contractorId that is not an id", { ...valid, contractorId: "linh" }, "contractorId: Choose a contractor"],
    ["a title under 3 characters", { ...valid, title: "ok" }, "title: Say what was delivered, in at least 3 characters"],
    ["an amount with more than 6 decimal places", { ...valid, amount: "1.0000001" }, "amount: Use a positive USDC amount with at most 6 decimal places"],
    ["a zero amount", { ...valid, amount: 0 }, "amount: Amount must be greater than zero"],
    ["a link that is not https", { ...valid, verificationSource: "http://github.com/acme/widgets/pull/42" }, "verificationSource: The evidence link must start with https://"],
    ["a missing title", { contractorId: CONTRACTOR, amount: "1" }, /^title: /],
  ] as const)("answers 400 to %s, naming the field, and writes and remembers nothing", async (_label, body, message) => {
    const { fake, send } = workspace();
    const response = await send(body, { "idempotency-key": "ci-bounty-pr-42" });

    expect(response.status).toBe(400);
    const answer = (await response.json()) as { error: { code: string; message: string } };
    expect(answer.error.code).toBe("invalid_request");
    if (typeof message === "string") expect(answer.error.message).toBe(message);
    else expect(answer.error.message).toMatch(message);
    expect(requestsTo(fake.requests, "/rest/v1/api_idempotency")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/counterparties")).toEqual([]);
    expect(milestoneInsert(fake.requests)).toBeUndefined();
  });

  it("gives a repeat with the same Idempotency-Key and body the first answer back, and adds nothing (W6)", async () => {
    const raw = JSON.stringify(valid);
    const first = { data: { id: MILESTONE } };
    const { fake, send } = workspace({
      stored: { request_hash: crypto.createHash("sha256").update(`POST /api/v1/milestones\n${raw}`).digest("hex"), status: 201, response: first },
    });
    const response = await send(raw, { "idempotency-key": "ci-bounty-pr-42" });

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await response.json()).toEqual(first);
    expect(milestoneInsert(fake.requests)).toBeUndefined();
  });

  it("refuses a key whose issuer can no longer add records, before anything is written (W5)", async () => {
    const { fake, send } = workspace({ role: "approver" });
    expect((await send(valid)).status).toBe(403);
    expect(milestoneInsert(fake.requests)).toBeUndefined();
  });
});
