import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/slack/commands/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { handleSlashCommand } from "@/lib/slack/commands";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `/vestiarion` (Slack design S2, S4–S6): verified before anything is read, answered at once with nothing, and worked
 * after the response, the answer posted to the command's `response_url`. Only a member who connected their own Slack
 * account is answered from the workspace; `connect` gives a one-time link to that person alone; `pause` stops the agent
 * through the command every surface shares, and tells the channel.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { pause: vi.fn(), todayFacts: vi.fn(), waitingFacts: vi.fn(), verifyLedger: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/commands/agent", () => ({ pauseWorkspaceAgent: mocks.pause }));
vi.mock("@/lib/telegram/today", () => ({ todayFacts: mocks.todayFacts, waitingFacts: mocks.waitingFacts }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), verifyLedger: mocks.verifyLedger }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c61";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c62";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c63";
const SETTINGS = { clientId: "1.2", clientSecret: "client-secret", signingSecret: "signing-secret-for-tests" };
const RESPONSE_URL = "https://hooks.slack.com/commands/T0TEAM/1/abc";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

let installed: boolean;
let linked: boolean;

beforeEach(() => {
  installed = true;
  linked = true;
  for (const mock of Object.values(mocks)) mock.mockReset();
});

function signedRequest(fields: Record<string, string>, secret = SETTINGS.signingSecret, at = Math.floor(Date.now() / 1000)): Request {
  const body = new URLSearchParams({ team_id: "T0TEAM", user_id: "U0LINH", user_name: "linh", command: "/vestiarion", response_url: RESPONSE_URL, ...fields }).toString();
  const signature = `v0=${crypto.createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`;
  return new Request("https://www.vestiarion.xyz/api/slack/commands", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": signature, "x-slack-request-timestamp": String(at) },
    body,
  });
}

function world() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "acme", name: "Acme", mode: "live" }) };
    if (sent.path === "/rest/v1/slack_installs") {
      return { body: installed ? [{ id: "inst-1", org_id: ORG, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0FIN", notified_seq: 0, decisions_limit_usdc: null, installed_at: "2026-10-03T08:00:00Z", team_name: null, channel_name: null, installed_by: null, bot_token_enc: {}, webhook_url_enc: {} }] : [] };
    }
    if (sent.path === "/rest/v1/slack_links" && sent.method === "GET") {
      return { body: linked ? [{ id: LINK_ID, org_id: ORG, user_id: USER, team_id: "T0TEAM", slack_user_id: "U0LINH", linked_at: "2026-10-03T09:00:00Z" }] : [] };
    }
    if (sent.path === "/rest/v1/slack_links" && sent.method === "DELETE") return { body: [{ id: LINK_ID }] };
    if (sent.path === "/rest/v1/memberships") return { body: [{ role: "approver" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const answers: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(RESPONSE_URL);
    answers.push(JSON.parse(String(init?.body)));
    return new Response("ok");
  }) as typeof fetch;
  const deferred: Array<Promise<void>> = [];
  const handle = async (request: Request) => {
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handleSlashCommand(request, { settings: SETTINGS, origin: "https://www.vestiarion.xyz", fetchImpl, defer: (work) => void deferred.push(runWith({ config, db: fake.client, fetch: fake.fetch }, work)) })
    );
    await Promise.all(deferred);
    return response;
  };
  return { fake, handle, answers };
}

describe("the /vestiarion route", () => {
  it("is not there when Slack is not configured", async () => {
    const response = await POST(signedRequest({ text: "today" }));
    expect(response.status).toBe(404);
  });
});

describe("handleSlashCommand", () => {
  it("answers 401 to a request Slack did not sign, and does nothing", async () => {
    const { fake, handle, answers } = world();
    expect((await handle(signedRequest({ text: "today" }, "another-secret"))).status).toBe(401);
    expect((await handle(signedRequest({ text: "today" }, SETTINGS.signingSecret, Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    expect(fake.requests).toEqual([]);
    expect(answers).toEqual([]);
  });

  it("answers Slack at once with nothing, then posts the answer to the command's response_url", async () => {
    mocks.todayFacts.mockResolvedValue({ safeToSpend: 12.5, cash: 50, reserve: 0, dueIn30d: 37.5, eurcLeftOut: 0, shortOn: null, waiting: 0, scheduled: [], lastCycleAt: null });
    const { handle, answers } = world();
    const response = await handle(signedRequest({ text: "today" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ response_type: "ephemeral" });
    expect(JSON.stringify(answers[0])).toContain("Safe to spend today: 12.50 USDC");
  });

  it("says a Slack workspace that is not connected to Vestiarion is not", async () => {
    installed = false;
    const { handle, answers } = world();
    await handle(signedRequest({ text: "today" }));
    expect(JSON.stringify(answers[0])).toContain("not connected to Vestiarion");
    expect(mocks.todayFacts).not.toHaveBeenCalled();
  });

  it("tells someone who has not connected their own account how to, and reads nothing for them", async () => {
    linked = false;
    const { handle, answers } = world();
    await handle(signedRequest({ text: "waiting" }));
    expect(JSON.stringify(answers[0])).toContain("/vestiarion connect");
    expect(mocks.waitingFacts).not.toHaveBeenCalled();
  });

  it("gives a one-time connect link to the person who asked, and only them", async () => {
    linked = false;
    const { fake, handle, answers } = world();
    await handle(signedRequest({ text: "connect" }));
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/slack_link_requests" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ team_id: "T0TEAM", slack_user_id: "U0LINH", slack_user_name: "linh" });
    expect(answers[0]).toMatchObject({ response_type: "ephemeral" });
    expect(JSON.stringify(answers[0])).toMatch(/https:\/\/www\.vestiarion\.xyz\/integrations\/slack\/connect\?code=[A-Za-z0-9_-]{43}/);
  });

  it("pauses the agent as the member, through Slack, and tells the channel", async () => {
    mocks.pause.mockResolvedValue({ ok: true, message: "Agent paused." });
    const { handle, answers } = world();
    await handle(signedRequest({ text: "pause a duplicate bill came in" }));
    expect(mocks.pause).toHaveBeenCalledWith(
      { orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "slack", linkId: LINK_ID, decisionsLimitUsdc: null } },
      { reason: "a duplicate bill came in" }
    );
    expect(answers[0]).toMatchObject({ response_type: "in_channel" });
    expect(JSON.stringify(answers[0])).toContain("<@U0LINH> paused the agent: a duplicate bill came in");
  });

  it("says a refused pause to the person alone", async () => {
    mocks.pause.mockResolvedValue({ ok: false, code: "already_paused", message: "The agent is already paused." });
    const { handle, answers } = world();
    await handle(signedRequest({ text: "pause" }));
    expect(answers[0]).toMatchObject({ response_type: "ephemeral" });
    expect(JSON.stringify(answers[0])).toContain("The agent is already paused.");
  });

  it("checks the ledger, lists what waits, and disconnects the account", async () => {
    mocks.verifyLedger.mockResolvedValue({ valid: true, checkedEntries: 9 });
    mocks.waitingFacts.mockResolvedValue([]);
    const { fake, handle, answers } = world();
    await handle(signedRequest({ text: "ledger" }));
    await handle(signedRequest({ text: "waiting" }));
    await handle(signedRequest({ text: "disconnect" }));
    expect(JSON.stringify(answers[0])).toContain("the ledger is intact: 9 entries");
    expect(JSON.stringify(answers[1])).toContain("Nothing waits for a person.");
    expect(JSON.stringify(answers[2])).toContain("disconnected");
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/slack_links" && sent.method === "DELETE")).toBe(true);
  });

  it("answers help, or anything it does not know, with what it does", async () => {
    const { handle, answers } = world();
    await handle(signedRequest({ text: "" }));
    await handle(signedRequest({ text: "dance" }));
    expect(JSON.stringify(answers[0])).toContain("/vestiarion pause");
    expect(JSON.stringify(answers[1])).toContain("/vestiarion today");
  });
});
