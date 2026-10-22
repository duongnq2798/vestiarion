import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import type { AgentActivity } from "@/lib/agent-activity-read";
import { CYCLE_STAGES, STAGE_REQUIRES } from "@/lib/agent/journal";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { sendDiscordWaiting, STAGE_BUDGET_MS } from "@/lib/discord/notify";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The cycle's `discord` stage (docs/superpowers/specs/2026-10-22-discord-design.md DC3, DC5): the channel is told the
 * payables the agent stopped for a person after its cursor, still held or flagged, in one message; the cursor moves once
 * Discord took it, or refused it outright; a failure is recorded for Settings; a webhook Discord says is gone is
 * disconnected; and nothing happens before migration 0139.
 */

const { readActivityMock, usdcValueMock } = vi.hoisted(() => ({ readActivityMock: vi.fn(), usdcValueMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-activity-read", () => ({ readAgentActivity: readActivityMock }));
vi.mock("@/lib/agent/second-approval", () => ({ usdcValueOfLatestDecision: usdcValueMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const ROW_ID = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e02";
const TOKEN = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123";
const WEBHOOK = `https://discord.com/api/webhooks/1234567890123456789/${TOKEN}`;
const ORIGIN = "https://www.vestiarion.xyz";
const INVOICE = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const item = (seq: number, fields: Partial<ActivityItem>): ActivityItem => ({
  seq, text: "", detail: null, tone: "stopped", path: "/invoices", pathLabel: "Bills & receivables", txHash: null, txUrl: null, network: "arc-testnet", ...fields,
});
const stopped = (seq: number, n: number) => item(seq, { text: `Held Vendor ${n}.`, path: `/approvals#payable-${INVOICE(n)}`, pathLabel: "Decide in Approvals", invoiceId: INVOICE(n) });
const PAID = item(51, { text: "Paid Centronex 0.35 USDC.", tone: "done" });
/** A request for details: stopped, about a payable, but decided by adding details, not in Approvals. */
const ASKED = item(55, { text: "Asked for details.", path: `/invoices?invoice=${INVOICE(3)}`, pathLabel: "Add details", invoiceId: INVOICE(3) });
const activity = (items: ActivityItem[], through: number): AgentActivity => ({ running: null, head: through, lastCycleAt: null, items, through });

const invoice = (n: number, fields: Record<string, unknown> = {}) => ({
  id: INVOICE(n), amount: "120.00", currency: "USDC", status: "held", direction: "payable", agent_reasoning: "The invoice has no purchase order. It waits for a person.",
  counterparties: { name: `Vendor ${n}` }, ...fields,
});

let connection: Record<string, unknown> | null;
let connectionReply: FakeReply | null;
let invoices: Array<Record<string, unknown>>;
let policy: Array<Record<string, unknown>>;
let policyReply: FakeReply | null;

function connectionRow(fields: Record<string, unknown> = {}) {
  const keys = parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
  return {
    id: ROW_ID, org_id: ORG, webhook_id: "1234567890123456789", channel_id: "3234567890123456789", guild_id: null, name: "Finance", connected_by: null,
    connected_at: "2026-10-22T08:00:00Z", notified_seq: 40, last_error: null, last_error_at: null, failures: 0,
    webhook_url_enc: encryptSecret(WEBHOOK, { orgId: ORG, column: "discord_webhooks.webhook_url_enc" }, keys), ...fields,
  };
}

beforeEach(() => {
  connection = null;
  connectionReply = null;
  invoices = [];
  policy = [];
  policyReply = null;
  readActivityMock.mockReset();
  usdcValueMock.mockReset();
});

function stage(replies: Array<() => Response> = [() => Response.json({ id: "1" })], options: { now?: () => number } = {}) {
  const posts: Array<{ url: string; body: { content: string } & Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const reply = replies[Math.min(posts.length - 1, replies.length - 1)];
    return reply();
  }) as typeof fetch;
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "acme", name: "Acme Studio" }) };
    if (sent.path === "/rest/v1/discord_webhooks" && sent.method === "GET") return connectionReply ?? { body: connection ? [connection] : [] };
    if (sent.path === "/rest/v1/discord_webhooks" && sent.method === "DELETE") return { body: [{ id: ROW_ID }] };
    if (sent.path === "/rest/v1/invoices") return { body: invoices };
    if (sent.path === "/rest/v1/approval_policies") return policyReply ?? { body: policy };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const sleeps: number[] = [];
  const run = () =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        sendDiscordWaiting({ fetchImpl, origin: ORIGIN, now: options.now ?? (() => 0), sleep: async (ms) => void sleeps.push(ms) })
      )
    );
  const patches = () => fake.requests.filter((sent) => sent.path === "/rest/v1/discord_webhooks" && sent.method === "PATCH").map((sent) => sent.body as Record<string, unknown>);
  const cursor = () => patches().filter((body) => "notified_seq" in body).map((body) => body.notified_seq);
  const failures = () => patches().filter((body) => "failures" in body);
  const ledger = () => fake.requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_actor: string; p_detail: Record<string, unknown> });
  return { fake, run, posts, cursor, failures, ledger, sleeps };
}

const json = (body: unknown, status: number) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("sendDiscordWaiting", () => {
  it("does nothing before migration 0139, or without a connection", async () => {
    connectionReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.discord_webhooks' in the schema cache" } };
    const before = stage();
    expect(await before.run()).toEqual([]);
    expect(before.posts).toEqual([]);
    expect(readActivityMock).not.toHaveBeenCalled();

    connectionReply = null;
    const none = stage();
    expect(await none.run()).toEqual([]);
    expect(none.posts).toEqual([]);
    expect(readActivityMock).not.toHaveBeenCalled();
  });

  it("posts only the payables still held or flagged, in one message, then moves the cursor past everything read", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity([PAID, stopped(52, 1), stopped(53, 2), stopped(54, 4), ASKED, stopped(56, 1)], 60));
    invoices = [
      invoice(1),
      invoice(2, { status: "flagged", amount: "75.5", currency: "EURC" }),
      invoice(3, { status: "awaiting_info" }),
      // Decided since the agent held it: no longer waiting.
      invoice(4, { status: "paid" }),
    ];
    const { run, posts, cursor, failures } = stage();
    expect(await run()).toEqual([{ domain: "system", message: "Told the workspace's Discord channel that 2 bills wait for approval" }]);
    expect(readActivityMock).toHaveBeenCalledWith(40);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${WEBHOOK}?wait=true`);
    expect(posts[0].body).toMatchObject({ username: "Vestiarion", allowed_mentions: { parse: [] }, flags: 4 });
    const lines = posts[0].body.content.split("\n");
    expect(lines[0]).toBe("**Acme Studio** · 2 bills wait for approval");
    expect(lines.filter((line) => line.startsWith("• "))).toEqual([
      `• **120.00 USDC** · Vendor 1 · held: The invoice has no purchase order. · Review: <${ORIGIN}/o/acme/approvals#payable-${INVOICE(1)}>`,
      `• **75.50 EURC** · Vendor 2 · flagged: The invoice has no purchase order. · Review: <${ORIGIN}/o/acme/approvals#payable-${INVOICE(2)}>`,
    ]);
    expect(lines.at(-1)).toBe("Opening a link never approves anything.");
    expect(cursor()).toEqual([60]);
    expect(failures()).toEqual([]);
  });

  it("reads the stopped payables again in one query", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity([stopped(52, 1), stopped(53, 2)], 60));
    invoices = [invoice(1), invoice(2)];
    const { fake, run } = stage();
    await run();
    const reads = fake.requests.filter((sent) => sent.path === "/rest/v1/invoices");
    expect(reads).toHaveLength(1);
    expect(reads[0].params.get("id")).toBe(`in.(${INVOICE(1)},${INVOICE(2)})`);
  });

  it("moves past what was read, posting nothing, when no bill waits", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity([PAID, ASKED], 61));
    invoices = [invoice(3, { status: "awaiting_info" })];
    const { run, posts, cursor } = stage();
    expect(await run()).toEqual([]);
    expect(posts).toEqual([]);
    expect(cursor()).toEqual([61]);
  });

  it("lists ten bills, then how many more wait in Approvals", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity(Array.from({ length: 12 }, (_, i) => stopped(50 + i, i + 1)), 70));
    invoices = Array.from({ length: 12 }, (_, i) => invoice(i + 1, { agent_reasoning: null }));
    const { run, posts } = stage();
    expect(await run()).toEqual([{ domain: "system", message: "Told the workspace's Discord channel that 12 bills wait for approval" }]);
    expect(posts[0].body.content.match(/^• /gm)).toHaveLength(10);
    expect(posts[0].body.content).toContain(`…and 2 more in Approvals: <${ORIGIN}/o/acme/approvals>`);
  });

  it("says a bill above the figure needs two approvals, and an accountant can co-sign while co-signing is on", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity([stopped(52, 1), stopped(53, 2)], 60));
    invoices = [invoice(1, { amount: "900" }), invoice(2, { amount: "20" })];
    policy = [{ two_approvals_above: "500", accountant_cosigns: false }];
    const off = stage();
    await off.run();
    const offLines = off.posts[0].body.content.split("\n").filter((line) => line.startsWith("• "));
    expect(offLines[0]).toContain(" · needs two approvals · Review:");
    expect(offLines[1]).not.toContain("two approvals");

    policy = [{ two_approvals_above: "500", accountant_cosigns: true }];
    const on = stage();
    await on.run();
    const onLines = on.posts[0].body.content.split("\n").filter((line) => line.startsWith("• "));
    expect(onLines[0]).toContain(" · needs two approvals, an accountant can co-sign · Review:");
    expect(onLines[1]).not.toContain("co-sign");
  });

  it("weighs a EURC bill by its last decision's USDC value, only where a figure is set", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity([stopped(52, 1)], 60));
    invoices = [invoice(1, { currency: "EURC", amount: "450" })];
    usdcValueMock.mockResolvedValue(490);
    policy = [{ two_approvals_above: "500", accountant_cosigns: false }];
    const under = stage();
    await under.run();
    expect(usdcValueMock).toHaveBeenCalledWith(INVOICE(1));
    expect(under.posts[0].body.content).not.toContain("two approvals");

    usdcValueMock.mockReset();
    policy = [];
    await stage().run();
    expect(usdcValueMock).not.toHaveBeenCalled();
  });

  it("still posts when the rules cannot be read, without saying what a bill needs", async () => {
    connection = connectionRow();
    readActivityMock.mockResolvedValue(activity([stopped(52, 1)], 60));
    invoices = [invoice(1, { amount: "900" })];
    policyReply = { status: 500, body: { code: "XX000", message: "boom" } };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run, posts, cursor } = stage();
    expect(await run()).toHaveLength(1);
    expect(posts[0].body.content).not.toContain("two approvals");
    expect(cursor()).toEqual([60]);
    expect(String(error.mock.calls[0])).toContain("discord: the figure for two approvals was not read");
    error.mockRestore();
  });

  it("clears a recorded failure once Discord takes a message", async () => {
    connection = connectionRow({ last_error: "Discord answered 503.", last_error_at: "2026-10-22T07:00:00Z", failures: 2 });
    readActivityMock.mockResolvedValue(activity([stopped(52, 1)], 60));
    invoices = [invoice(1)];
    const { run, cursor, failures } = stage();
    await run();
    expect(cursor()).toEqual([60]);
    expect(failures()).toEqual([{ last_error: null, last_error_at: null, failures: 0 }]);
  });

  describe("when Discord does not take it", () => {
    let error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      connection = connectionRow({ failures: 1 });
      readActivityMock.mockResolvedValue(activity([stopped(52, 1)], 60));
      invoices = [invoice(1)];
      error = vi.spyOn(console, "error").mockImplementation(() => {});
      return () => {
        // The status and Discord's code, never the webhook's URL.
        expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
        error.mockRestore();
      };
    });

    it("keeps the cursor and records the failure on a server error", async () => {
      const { run, cursor, failures } = stage([() => new Response("bad gateway", { status: 502 })]);
      expect(await run()).toEqual([]);
      expect(cursor()).toEqual([]);
      expect(failures()).toEqual([{ last_error: "Discord answered 502. The bills are posted again with the next cycle.", last_error_at: expect.any(String), failures: 2 }]);
    });

    it("keeps the cursor and records the failure when Discord cannot be reached", async () => {
      const { run, cursor, failures } = stage([
        () => {
          throw new TypeError(`fetch failed ${WEBHOOK}`);
        },
      ]);
      expect(await run()).toEqual([]);
      expect(cursor()).toEqual([]);
      expect(failures()[0]).toMatchObject({ last_error: "Discord could not be reached. The bills are posted again with the next cycle.", failures: 2 });
    });

    it("records a refused message and moves past it, so it cannot jam the channel", async () => {
      const { run, cursor, failures } = stage([json({ message: "Invalid Form Body", code: 50035 }, 400)]);
      expect(await run()).toEqual([]);
      expect(failures()[0]).toMatchObject({ last_error: "Discord refused the message (400, code 50035). Those bills wait in Approvals.", failures: 2 });
      expect(cursor()).toEqual([60]);
    });

    it("waits once for a short 429 and posts again", async () => {
      const { run, posts, cursor, sleeps } = stage([json({ retry_after: 0.4 }, 429), () => Response.json({ id: "1" })]);
      expect(await run()).toHaveLength(1);
      expect(sleeps).toEqual([400]);
      expect(posts).toHaveLength(2);
      expect(cursor()).toEqual([60]);
    });

    it("keeps the cursor, waiting no longer, when a 429 asks for more than 2 seconds, says nothing, or comes again", async () => {
      for (const replies of [[json({ retry_after: 5 }, 429)], [() => new Response("<html></html>", { status: 429 })], [json({ retry_after: 1 }, 429), json({ retry_after: 1 }, 429)]]) {
        const { run, posts, cursor, failures, sleeps } = stage(replies);
        expect(await run()).toEqual([]);
        expect(cursor()).toEqual([]);
        expect(failures()).toEqual([]);
        expect(posts.length).toBe(sleeps.length + 1);
        expect(sleeps.length).toBeLessThanOrEqual(1);
      }
    });

    it("waits for no 429 the stage's budget cannot afford", async () => {
      let clock = 0;
      const { run, posts, sleeps, cursor } = stage([json({ retry_after: 2 }, 429), () => Response.json({ id: "1" })], {
        now: () => {
          const at = clock;
          clock = STAGE_BUDGET_MS - 1_000;
          return at;
        },
      });
      expect(await run()).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(posts).toHaveLength(1);
      expect(cursor()).toEqual([]);
    });

    it.each([
      ["404, Unknown Webhook", json({ message: "Unknown Webhook", code: 10015 }, 404)],
      ["401, Invalid Webhook Token", json({ message: "Invalid Webhook Token", code: 50027 }, 401)],
      ["403", json({ message: "Missing Access", code: 50001 }, 403)],
      ["400 with code 10015", json({ message: "Unknown Webhook", code: 10015 }, 400)],
    ])("disconnects a webhook Discord says is gone: %s", async (_why, reply) => {
      const { fake, run, cursor, failures, ledger } = stage([reply]);
      expect(await run()).toEqual([{ domain: "system", message: "Discord said the workspace's channel webhook is gone, so Discord was disconnected" }]);
      expect(fake.requests.filter((sent) => sent.path === "/rest/v1/discord_webhooks" && sent.method === "DELETE")).toHaveLength(1);
      expect(ledger()[0]).toMatchObject({ p_action: "discord_disconnected", p_actor: "system", p_detail: { by: null, webhookId: "1234567890123456789", via: "discord" } });
      expect(cursor()).toEqual([]);
      expect(failures()).toEqual([]);
    });
  });
});

describe("the discord stage in the cycle", () => {
  it("comes last, after telegram and slack, and needs no other stage to have succeeded", () => {
    expect(CYCLE_STAGES.slice(-3)).toEqual(["telegram", "slack", "discord"]);
    expect(STAGE_REQUIRES.discord).toEqual([]);
  });
});
