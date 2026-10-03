import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { addMilestone } from "@/lib/commands/milestones";
import { milestoneInputSchema } from "@/lib/intake-validation";
import { carriesOrg, fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Adding a milestone, as one command for every surface (write API part 2, W2, W4): the gate first, then the contractor
 * looked up in the workspace in scope, the milestone added pending as the actor's, and the ledger entry naming the
 * surface it came from. A GitHub pull request is kept canonical, and the agent's check runs within a minute when a
 * GitHub token is configured.
 */

const { cycleMock, ledgerMock } = vi.hoisted(() => ({ cycleMock: vi.fn(), ledgerMock: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: cycleMock }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const CONTRACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c11e";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";
const KEY_ID = "3c3c3c3c-0000-4000-8000-000000000001";
const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };

const admin = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "admin", mode: "live", surface: { kind: "console" }, ...fields });
const viaApi = admin({ surface: { kind: "api", apiKeyId: KEY_ID } });

const COUNTERPARTIES = [
  { id: CONTRACTOR, name: "Linh Design", role: "contractor" },
  { id: CLIENT, name: "Lumen Retail", role: "client" },
];

function workspace(options: { githubToken?: string; insertFails?: boolean } = {}) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/counterparties") return { body: COUNTERPARTIES.filter((row) => sent.params.get("id") === `eq.${row.id}`) };
    if (sent.path === "/rest/v1/milestones" && sent.method === "POST") {
      return options.insertFails ? { status: 500, body: { message: "connection reset" } } : { body: { id: MILESTONE } };
    }
    return { body: [] };
  });
  const config = configFromEnv(options.githubToken ? { ...ENV, GITHUB_TOKEN: options.githubToken } : ENV);
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

const milestone = (fields: Record<string, string> = {}) =>
  milestoneInputSchema.parse({ contractorId: CONTRACTOR, title: "Five October posts", amount: "12.50", evidence: "", ...fields });
const inserts = (requests: RecordedRequest[]) => requests.filter((sent) => sent.path === "/rest/v1/milestones" && sent.method === "POST");
const VERIFY_LATER = "Milestone added for Linh Design. Verify it once the work is delivered, and the agent decides on pay within a minute.";
const CHECKS_PR = "Milestone added for Linh Design. The agent checks the pull request within a minute, and decides on pay once it is merged.";

beforeEach(() => {
  cycleMock.mockReset();
  ledgerMock.mockReset();
});

describe("addMilestone", () => {
  it("adds it pending, as the actor's, in the workspace in scope, and records it", async () => {
    const { fake, run } = workspace();
    const outcome = await run(() => addMilestone(admin(), { milestone: milestone({ evidence: "https://www.canva.com/design/DAG123/view" }) }));

    expect(outcome).toEqual({ ok: true, message: VERIFY_LATER, milestoneId: MILESTONE, contractorName: "Linh Design" });
    const [insert] = inserts(fake.requests);
    expect(insert.body).toEqual({
      org_id: ORG,
      contractor_id: CONTRACTOR,
      title: "Five October posts",
      amount: "12.50",
      verification_source: "https://www.canva.com/design/DAG123/view",
      created_by: USER,
    });
    expect(carriesOrg(fake.requests.find((sent) => sent.path === "/rest/v1/counterparties")!, ORG)).toBe(true);
    expect(ledgerMock).toHaveBeenCalledWith({
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
        verificationSource: "https://www.canva.com/design/DAG123/view",
      },
    });
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("names the API and the key in the entry for a milestone added through it", async () => {
    const { fake, run } = workspace();
    await run(() => addMilestone(viaApi, { milestone: milestone() }));

    expect(inserts(fake.requests)[0].body).toMatchObject({ created_by: USER, verification_source: null });
    expect(ledgerMock.mock.calls[0][0].detail).toEqual({
      by: USER,
      milestoneId: MILESTONE,
      counterpartyId: CONTRACTOR,
      counterpartyName: "Linh Design",
      amount: "12.50",
      verificationSource: null,
      via: "api",
      apiKeyId: KEY_ID,
    });
  });

  it("keeps a pull request canonical, and has the agent check it within a minute when a GitHub token is configured", async () => {
    const { fake, run } = workspace({ githubToken: "github-read-token" });
    const outcome = await run(() => addMilestone(viaApi, { milestone: milestone({ evidence: "https://github.com/acme/widgets/pull/42/" }) }));

    expect(outcome).toMatchObject({ ok: true, message: CHECKS_PR });
    expect(inserts(fake.requests)[0].body).toMatchObject({ verification_source: "https://github.com/acme/widgets/pull/42" });
    expect(cycleMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "milestone_added" });
  });

  it("promises no pull request check without a GitHub token, and starts no cycle", async () => {
    const { run } = workspace();
    const outcome = await run(() => addMilestone(admin(), { milestone: milestone({ evidence: "https://github.com/acme/widgets/pull/42" }) }));

    expect(outcome).toMatchObject({ ok: true, message: VERIFY_LATER });
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("refuses a client, who pays the business rather than being paid by it, and adds nothing", async () => {
    const { fake, run } = workspace();
    expect(await run(() => addMilestone(viaApi, { milestone: milestone({ contractorId: CLIENT }) }))).toEqual({
      ok: false,
      code: "client",
      message: "A client is not paid for milestones. Choose a contractor or vendor.",
    });
    expect(inserts(fake.requests)).toEqual([]);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("answers a contractor the workspace does not hold as not found, and adds nothing", async () => {
    const { fake, run } = workspace();
    expect(await run(() => addMilestone(viaApi, { milestone: milestone({ contractorId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000dead" }) }))).toEqual({
      ok: false,
      code: "contractor_not_found",
      message: "Contractor not found.",
    });
    expect(inserts(fake.requests)).toEqual([]);
  });

  it.each([
    ["an approver, who may not add records", admin({ role: "approver" }), "forbidden"],
    ["the Telegram bot", admin({ surface: { kind: "telegram", linkId: "l-1" } }), "surface"],
    ["Slack", admin({ surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: 10 } }), "surface"],
  ] as const)("refuses %s before reading anything", async (_label, actor, code) => {
    const { fake, run } = workspace();
    expect(await run(() => addMilestone(actor, { milestone: milestone() }))).toMatchObject({ ok: false, code });
    expect(fake.requests).toEqual([]);
  });

  it("refuses with words a person can act on when the write fails, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = workspace({ insertFails: true });
    expect(await run(() => addMilestone(admin(), { milestone: milestone() }))).toEqual({
      ok: false,
      code: "failed",
      message: "The milestone could not be added. Try again in a moment.",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
