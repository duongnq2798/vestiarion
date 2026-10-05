import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import type { AgentActivity } from "@/lib/agent-activity-read";
import { CYCLE_STAGES, STAGE_REQUIRES } from "@/lib/agent/journal";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { sendSlackDecisions } from "@/lib/slack/notify";
import { addressHash, readCard } from "@/lib/slack/state";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The cycle's `slack` stage (Slack design S7, S8): the install's channel is told the agent's decisions after its
 * cursor, through the incoming webhook, and the cursor moves only when Slack took the message. A stopped payable gets
 * its card when deciding from Slack is on: a signed token on each button, Approve only when the payable qualifies.
 */

const { readActivityMock } = vi.hoisted(() => ({ readActivityMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-activity-read", () => ({ readAgentActivity: readActivityMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c51";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-000000000c52";
const ADDRESS = "0x1111222233334444555566667777888899990000";
const WEBHOOK = "https://hooks.slack.com/services/T0TEAM/B0HOOK/abcdefghijklmnopqrstuvwx";
const SETTINGS = { clientId: "1.2", clientSecret: "client-secret", signingSecret: "signing-secret" };
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const PAID: ActivityItem = { seq: 52, text: "Paid Centronex 0.35 USDC.", detail: null, tone: "done", path: "/invoices", pathLabel: "AP / AR", txHash: null, txUrl: null };
const HELD: ActivityItem = {
  seq: 53, text: "Held Jiren 0.50 USDC for you.", detail: "No purchase order.", tone: "stopped", path: `/approvals#payable-${INVOICE}`, pathLabel: "Decide in Approvals",
  txHash: null, txUrl: null, invoiceId: INVOICE,
};
const activity = (items: ActivityItem[], through: number): AgentActivity => ({ running: null, head: through, lastCycleAt: null, items, through });

let install: Record<string, unknown> | null;
let invoices: Array<Record<string, unknown>>;

function installRow(fields: Record<string, unknown> = {}) {
  const keys = parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
  const envelope = (value: string, column: string) => encryptSecret(value, { orgId: ORG, column }, keys);
  return {
    id: "inst-1", org_id: ORG, team_id: "T0TEAM", team_name: "Acme", app_id: "A0APP", channel_id: "C0FIN", channel_name: "#finance", installed_by: null,
    installed_at: "2026-10-03T08:00:00Z", notified_seq: 40, decisions_limit_usdc: null,
    bot_token_enc: envelope("xoxb-1", "slack_installs.bot_token_enc"), webhook_url_enc: envelope(WEBHOOK, "slack_installs.webhook_url_enc"), ...fields,
  };
}

const heldInvoice = (fields: Record<string, unknown> = {}) => ({
  id: INVOICE, amount: "0.50", currency: "USDC", status: "held", direction: "payable", decided_at: "2026-10-03T11:58:00+00:00", early_pay_discount_pct: null,
  counterparties: { name: "Jiren", address: ADDRESS, chain: null, address_changed_at: null, address_confirmed_at: null }, ...fields,
});

beforeEach(() => {
  install = null;
  invoices = [];
  readActivityMock.mockReset();
});

function stage(reply: (body: string) => Response = () => new Response("ok")) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return reply(String(init?.body));
  }) as typeof fetch;
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "acme", name: "Acme" }) };
    if (sent.path === "/rest/v1/slack_installs" && sent.method === "GET") return { body: install ? [install] : [] };
    if (sent.path === "/rest/v1/invoices") return { body: invoices };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = (settings: typeof SETTINGS | null = SETTINGS) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => sendSlackDecisions({ settings, fetchImpl, origin: "https://www.vestiarion.xyz", now: () => Date.UTC(2026, 9, 3, 12) }))
    );
  const cursor = () =>
    fake.requests.filter((sent) => sent.path === "/rest/v1/slack_installs" && sent.method === "PATCH").map((sent) => (sent.body as { notified_seq: number }).notified_seq);
  return { fake, run, posts, cursor };
}

describe("sendSlackDecisions", () => {
  it("does nothing when Slack is not configured, or the workspace has no install", async () => {
    const off = stage();
    expect(await off.run(null)).toEqual([]);
    expect(off.fake.requests.some((sent) => sent.path === "/rest/v1/slack_installs")).toBe(false);

    const none = stage();
    expect(await none.run()).toEqual([]);
    expect(none.posts).toEqual([]);
    expect(readActivityMock).not.toHaveBeenCalled();
  });

  it("posts the decisions after the cursor to the install's channel, then moves the cursor past them", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([PAID], 57));
    const { run, posts, cursor } = stage();
    expect(await run()).toEqual([{ domain: "system", message: "Told the workspace's Slack channel what the agent decided" }]);
    expect(readActivityMock).toHaveBeenCalledWith(40);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(WEBHOOK);
    expect(JSON.stringify(posts[0].body)).toContain("Paid Centronex 0.35 USDC.");
    expect(cursor()).toEqual([57]);
  });

  it("keeps the cursor when Slack did not take the message, for the next cycle", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([PAID], 57));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run, cursor } = stage(() => new Response("no_service", { status: 404 }));
    expect(await run()).toEqual([]);
    expect(cursor()).toEqual([]);
    expect(String(error.mock.calls[0])).not.toContain("hooks.slack.com");
    error.mockRestore();
  });

  it("moves past entries that say nothing, posting nothing", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([], 60));
    const { run, posts, cursor } = stage();
    expect(await run()).toEqual([]);
    expect(posts).toEqual([]);
    expect(cursor()).toEqual([60]);
  });

  it("draws no card while deciding from Slack is off, and reads nothing for one", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();
    await run();
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
    expect(JSON.stringify(posts[0].body)).not.toContain("vx_approve");
  });

  it("draws a stopped payable's card when it is on: a signed card on each button, Approve confirmed with the payee", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();
    await run();

    const reads = fake.requests.filter((sent) => sent.path === "/rest/v1/invoices");
    expect(reads).toHaveLength(1);
    expect(reads[0].params.get("id")).toBe(`in.(${INVOICE})`);
    const body = JSON.stringify(posts[0].body);
    expect(body).toContain("vx_approve");
    expect(body).toContain("Pays 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000.");
    const token = /"value":"(vx1\.[^"]+)"/.exec(body)?.[1] ?? "";
    expect(readCard(token, parseMasterKeys(process.env.VESTIARION_MASTER_KEYS), Date.UTC(2026, 9, 3, 12))).toEqual({
      org: ORG, invoice: INVOICE, decidedAt: "2026-10-03T11:58:00+00:00", addressHash: addressHash(ADDRESS),
    });
  });

  it("leaves Approve out above the limit, and says why", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice({ amount: "5" })];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { run, posts } = stage();
    await run();
    const body = JSON.stringify(posts[0].body);
    expect(body).not.toContain("vx_approve");
    expect(body).toContain("vx_reject");
    expect(body).toContain("Approve it in Vestiarion: It is above the 1 USDC this workspace allows from Slack.");
  });
});

describe("the slack stage in the cycle", () => {
  it("comes last, after telegram, and needs no other stage to have succeeded", () => {
    expect(CYCLE_STAGES.slice(-2)).toEqual(["telegram", "slack"]);
    expect(STAGE_REQUIRES.slack).toEqual([]);
  });
});
