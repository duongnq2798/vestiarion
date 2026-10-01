import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createMilestoneAction } from "@/app/actions/milestones";
import { carriesOrg, fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * `createMilestoneAction`: a person records work a contractor is to be paid
 * for. Authorization, the ledger and the cycle event are faked; the rows it
 * reads and writes go to a recorded supabase-js client, answered the way
 * PostgREST answers.
 */

const { ORG, USER, raiseMock, authorizeMock, appendLedgerEntryMock } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
  raiseMock: vi.fn(),
  authorizeMock: vi.fn(),
  appendLedgerEntryMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: appendLedgerEntryMock }));

const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };
let config = configFromEnv(ENV);
const CONTRACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c11e";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";

let fake: ReturnType<typeof fakeSupabase>;

vi.mock("@/lib/dal/scope", () => ({
  inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn),
}));

const ACCESS = {
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live", role: "owner" },
};

const COUNTERPARTIES = [
  { id: CONTRACTOR, name: "Linh Design", role: "contractor" },
  { id: CLIENT, name: "Lumen Retail", role: "client" },
];

/** This organization's counterparties, and the milestone insert. */
function workspace(sent: RecordedRequest) {
  const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
  if (sent.path === "/rest/v1/counterparties") {
    const found = COUNTERPARTIES.filter((row) => sent.params.get("id") === `eq.${row.id}`);
    if (!wantsObject) return { body: found };
    if (found.length === 1) return { body: found[0] };
    return {
      status: 406,
      body: { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "Cannot coerce the result to a single JSON object" },
    };
  }
  if (sent.path === "/rest/v1/milestones" && sent.method === "POST") {
    return { body: wantsObject ? { id: MILESTONE } : [{ id: MILESTONE }] };
  }
  return { body: [] };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  data.set("contractorId", CONTRACTOR);
  data.set("title", "Five October posts");
  data.set("amount", "12.50");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const empty = { ok: false, message: "" };
const inserts = () => fake.requests.filter((sent) => sent.path === "/rest/v1/milestones" && sent.method === "POST");

beforeEach(() => {
  config = configFromEnv(ENV);
  fake = fakeSupabase(workspace);
  raiseMock.mockReset();
  appendLedgerEntryMock.mockReset();
  authorizeMock.mockReset().mockResolvedValue(ACCESS);
});

describe("adding a milestone", () => {
  it("records it pending, for this organization, with the link kept as its evidence", async () => {
    const result = await createMilestoneAction(empty, form({ evidence: "https://www.canva.com/design/DAG123/view" }));

    expect(result).toEqual({
      ok: true,
      message: "Milestone added for Linh Design. Verify it once the work is delivered, and the agent decides on pay within a minute.",
    });
    expect(inserts()).toHaveLength(1);
    const [insert] = inserts();
    expect(insert.body).toMatchObject({
      contractor_id: CONTRACTOR,
      title: "Five October posts",
      amount: "12.50",
      verification_source: "https://www.canva.com/design/DAG123/view",
    });
    expect(insert.body).not.toHaveProperty("verified");
    expect(insert.body).not.toHaveProperty("status");
    expect(carriesOrg(insert, ORG)).toBe(true);
  });

  it("signs a human ledger entry for it", async () => {
    await createMilestoneAction(empty, form({ evidence: "" }));

    expect(appendLedgerEntryMock).toHaveBeenCalledTimes(1);
    expect(appendLedgerEntryMock).toHaveBeenCalledWith({
      actor: "human",
      domain: "contractor",
      action: "create_milestone",
      summary: "Added milestone “Five October posts” for Linh Design: 12.50 USDC",
      detail: {
        by: USER,
        milestoneId: MILESTONE,
        counterpartyId: CONTRACTOR,
        counterpartyName: "Linh Design",
        amount: "12.50",
        verificationSource: null,
      },
    });
  });

  it("raises nothing without a pull request: a person verifies the work first", async () => {
    await createMilestoneAction(empty, form({ evidence: "" }));
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("keeps a pull request in its canonical form, and has the agent check it within a minute", async () => {
    config = configFromEnv({ ...ENV, GITHUB_TOKEN: "github-read-token" });

    const result = await createMilestoneAction(empty, form({ evidence: "https://github.com/acme/widgets/pull/42/" }));

    expect(result).toEqual({
      ok: true,
      message: "Milestone added for Linh Design. The agent checks the pull request within a minute, and decides on pay once it is merged.",
    });
    expect(inserts()[0].body).toMatchObject({ verification_source: "https://github.com/acme/widgets/pull/42" });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "milestone_added");
  });

  it("promises no pull request check without a GitHub token, which would only report itself unavailable", async () => {
    const result = await createMilestoneAction(empty, form({ evidence: "https://github.com/acme/widgets/pull/42" }));

    expect(result).toEqual({
      ok: true,
      message: "Milestone added for Linh Design. Verify it once the work is delivered, and the agent decides on pay within a minute.",
    });
    expect(inserts()[0].body).toMatchObject({ verification_source: "https://github.com/acme/widgets/pull/42" });
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("answers a counterparty this organization does not hold as not found, and adds nothing", async () => {
    const result = await createMilestoneAction(empty, form({ contractorId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000dead" }));

    expect(result).toEqual({ ok: false, message: "Contractor not found." });
    const lookup = fake.requests.find((sent) => sent.path === "/rest/v1/counterparties");
    expect(lookup?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(inserts()).toHaveLength(0);
    expect(appendLedgerEntryMock).not.toHaveBeenCalled();
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("refuses a client, who pays the business rather than being paid by it", async () => {
    const result = await createMilestoneAction(empty, form({ contractorId: CLIENT }));

    expect(result).toEqual({ ok: false, message: "A client is not paid for milestones. Choose a contractor or vendor." });
    expect(inserts()).toHaveLength(0);
  });

  it.each([
    [{ title: "ok" }, "Say what was delivered, in at least 3 characters"],
    [{ title: "x".repeat(161) }, "Keep the milestone to 160 characters"],
    [{ amount: "0" }, "Amount must be greater than zero"],
    [{ amount: "1.1234567" }, "Use a positive USDC amount with at most 6 decimal places"],
    [{ evidence: "http://example.com/work" }, "The evidence link must start with https://"],
    [{ evidence: "not a link" }, "The evidence link must start with https://"],
    [{ evidence: `https://example.com/${"a".repeat(500)}` }, "Keep the evidence link to 500 characters"],
    [{ contractorId: "nope" }, "Choose a contractor"],
  ])("refuses %j with %j, before reading anything", async (fields, message) => {
    const result = await createMilestoneAction(empty, form(fields));

    expect(result).toEqual({ ok: false, message });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/counterparties")).toBe(false);
    expect(inserts()).toHaveLength(0);
  });

  it("does nothing for a caller who may not write records", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "Only an owner or admin can do that." });

    const result = await createMilestoneAction(empty, form({}));

    expect(result).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(fake.requests).toHaveLength(0);
    expect(raiseMock).not.toHaveBeenCalled();
  });
});
