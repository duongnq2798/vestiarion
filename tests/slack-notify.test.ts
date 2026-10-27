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
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The cycle's `slack` stage (Slack design S7, S8): the install's channel is told the agent's decisions after its
 * cursor, through the incoming webhook, and the cursor moves only when Slack took the message. A stopped payable gets
 * its card when deciding from Slack is on: a signed token on each button, Approve only when the payable qualifies.
 * While it is off, the bills still waiting are read as Telegram's and Discord's stages read them, and told in their own
 * section, each with a Review button (docs/superpowers/specs/2026-10-27-slack-review-links-design.md SR1, SR2).
 */

const { readActivityMock, usdcValueMock } = vi.hoisted(() => ({ readActivityMock: vi.fn(), usdcValueMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-activity-read", () => ({ readAgentActivity: readActivityMock }));
vi.mock("@/lib/agent/second-approval", async (importOriginal) => ({ ...(await importOriginal<object>()), usdcValueOfLatestDecision: usdcValueMock }));

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

const PAID: ActivityItem = { seq: 52, text: "Paid Centronex 0.35 USDC.", detail: null, tone: "done", path: "/invoices", pathLabel: "Bills & receivables", txHash: null, txUrl: null, network: "arc-testnet" };
const HELD: ActivityItem = {
  seq: 53, text: "Held Jiren 0.50 USDC for you.", detail: "No purchase order.", tone: "stopped", path: `/approvals#payable-${INVOICE}`, pathLabel: "Decide in Approvals",
  txHash: null, txUrl: null, invoiceId: INVOICE, network: "arc-testnet",
};
const activity = (items: ActivityItem[], through: number): AgentActivity => ({ running: null, head: through, lastCycleAt: null, items, through });

let install: Record<string, unknown> | null;
let invoices: Array<Record<string, unknown>>;
let invoicesReply: FakeReply | null;
let intents: Array<Record<string, unknown>>;
let policy: Array<Record<string, unknown>>;
/** The database before migration 0141: a read naming the late-fee columns is refused (late fees LF4). */
let before0141: boolean;

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
  invoicesReply = null;
  intents = [];
  policy = [];
  before0141 = false;
  readActivityMock.mockReset();
  usdcValueMock.mockReset();
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
    if (sent.path === "/rest/v1/invoices" && before0141 && (sent.params.get("select") ?? "").includes("late_fee_")) {
      return { status: 400, body: { code: "42703", message: "column invoices.late_fee_kind does not exist" } };
    }
    if (sent.path === "/rest/v1/invoices") return invoicesReply ?? { body: invoices };
    if (sent.path === "/rest/v1/payment_intents") return { body: intents };
    if (sent.path === "/rest/v1/approval_policies") return { body: policy };
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

  it("draws no card while deciding from Slack is off, and reads only whether its bill still waits (SR1)", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();
    await run();
    const reads = fake.requests.filter((sent) => sent.path === "/rest/v1/invoices");
    expect(reads.map((sent) => sent.params.get("select"))).toEqual(["id,amount,currency,status,direction,agent_reasoning,counterparties(name)"]);
    expect(reads[0].params.get("id")).toBe(`in.(${INVOICE})`);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/payment_intents")).toBe(false);
    expect(JSON.stringify(posts[0].body)).not.toContain("vx_approve");
  });

  it("draws a stopped payable's card when it is on: a signed card on each button, Approve confirmed with the payee", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();
    await run();

    const invoiceReads = fake.requests.filter((sent) => sent.path === "/rest/v1/invoices");
    // The cards' own read, then what each invoice's document asked to be paid to (invoice pay-to hold IP3).
    const reads = invoiceReads.filter((sent) => !sent.params.get("select")?.includes("document_pay_to"));
    expect(reads).toHaveLength(1);
    expect(reads[0].params.get("id")).toBe(`in.(${INVOICE})`);
    expect(invoiceReads.filter((sent) => sent.params.get("select") === "id,document_pay_to")).toHaveLength(1);
    const body = JSON.stringify(posts[0].body);
    expect(body).toContain("vx_approve");
    expect(body).toContain("Pays 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000.");
    const token = /"value":"(vx1\.[^"]+)"/.exec(body)?.[1] ?? "";
    expect(readCard(token, parseMasterKeys(process.env.VESTIARION_MASTER_KEYS), Date.UTC(2026, 9, 3, 12))).toEqual({
      org: ORG, invoice: INVOICE, decidedAt: "2026-10-03T11:58:00+00:00", addressHash: addressHash(ADDRESS),
    });
  });

  it("names a late fee on Approve's confirmation, as it names a discount, and that it is not paid (late fees LF4)", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice({ late_fee_kind: "percent_month", late_fee_value: "1.5", late_fee_starts_on: "2026-10-10" })];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { run, posts } = stage();
    await run();
    expect(JSON.stringify(posts[0].body)).toContain(
      "Pays 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000. A late fee of 1.5% a month starts Oct 10, 2026; it is never added to what is paid."
    );
  });

  it("reads the card's payable again without its late fee before migration 0141, and offers Approve as before", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    before0141 = true;
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();
    await run();
    const reads = fake.requests.filter((sent) => sent.path === "/rest/v1/invoices").map((sent) => (sent.params.get("select") ?? "").includes("late_fee_"));
    // The card's read naming the late-fee columns, refused, then the same read without them.
    expect(reads.slice(0, 2)).toEqual([true, false]);
    const body = JSON.stringify(posts[0].body);
    expect(body).toContain("vx_approve");
    expect(body).toContain("Pays 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000.");
  });

  it("says Approve checks the earlier transfer first when one may exist, never that it pays (payment exceptions E3)", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    intents = [
      {
        source_id: INVOICE, status: "failed", provider_tx_id: null, provider_state: null, failure_reason: null, payout_route: null,
        last_error: "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted", updated_at: "2026-10-03T11:57:00+00:00",
      },
    ];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();
    await run();

    const read = fake.requests.find((sent) => sent.path === "/rest/v1/payment_intents");
    expect(read?.params.get("source_type")).toBe("eq.invoice");
    expect(read?.params.get("source_id")).toBe(`in.(${INVOICE})`);
    const body = JSON.stringify(posts[0].body);
    expect(body).toContain(
      "Looks for the earlier transfer on Circle first: records it if Circle has it, and sends the payment only once Circle shows none. It is 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000."
    );
    expect(body).not.toContain("Pays 0.50 USDC");
  });

  it("says Approve checks a transfer already in flight and sends nothing new", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    intents = [{ source_id: INVOICE, status: "pending", provider_tx_id: "circle-tx-1", provider_state: "SENT", failure_reason: null, payout_route: null, last_error: null, updated_at: "2026-10-03T11:57:00+00:00" }];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { run, posts } = stage();
    await run();

    expect(JSON.stringify(posts[0].body)).toContain("Checks the transfer already sent with Circle and records it: nothing new is sent. It is 0.50 USDC to Jiren on Arc testnet, to 0x1111…0000.");
  });

  /** The confirmation on the posted card's Approve and pay button. */
  const approveConfirm = (body: Record<string, unknown>) => {
    const blocks = (body.blocks ?? []) as Array<{ elements?: Array<{ action_id?: string; confirm?: { title: { text: string }; text: { text: string }; confirm: { text: string } } }> }>;
    return blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "vx_approve")?.confirm;
  };

  it("titles and labels the confirmation for what Approve does when it checks first (payment exceptions review 4)", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    intents = [{ source_id: INVOICE, status: "pending", provider_tx_id: "circle-tx-1", provider_state: "SENT", failure_reason: null, payout_route: null, last_error: null, updated_at: "2026-10-03T11:57:00+00:00" }];
    const checking = stage();
    await checking.run();
    expect(approveConfirm(checking.posts[0].body)).toMatchObject({ title: { text: "Check the payment already sent?" }, confirm: { text: "Check it" } });

    intents = [{ ...intents[0], status: "failed", provider_tx_id: null, provider_state: null, last_error: "the transfer may or may not have been accepted" }];
    const looking = stage();
    await looking.run();
    expect(approveConfirm(looking.posts[0].body)).toMatchObject({ title: { text: "Look for the earlier payment first?" }, confirm: { text: "Look first" } });

    intents = [];
    const paying = stage();
    await paying.run();
    expect(approveConfirm(paying.posts[0].body)).toMatchObject({ title: { text: "Approve and pay?" }, confirm: { text: "Approve and pay" } });
  });

  it("keeps the confirmation within Slack's 300 characters whatever the payee's name (payment exceptions review 4)", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    const name = "Northwind Hosting & Data Services International Holdings ".repeat(8).trim();
    invoices = [heldInvoice({ early_pay_discount_pct: "2", counterparties: { name, address: ADDRESS, chain: null, address_changed_at: null, address_confirmed_at: null } })];
    intents = [{ source_id: INVOICE, status: "failed", provider_tx_id: null, provider_state: null, failure_reason: null, payout_route: null, last_error: "the transfer may or may not have been accepted", updated_at: "2026-10-03T11:57:00+00:00" }];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { run, posts } = stage();
    await run();

    const confirm = approveConfirm(posts[0].body);
    expect(confirm?.text.text.length).toBeLessThanOrEqual(300);
    expect(confirm?.text.text).toMatch(/^Looks for the earlier transfer on Circle first/);
    expect(confirm?.text.text).toContain("Northwind Hosting");
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

const ORIGIN = "https://www.vestiarion.xyz";
const BILL = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const stopped = (seq: number, n: number): ActivityItem => ({
  seq, text: `Held Vendor ${n} 120.00 USDC for you.`, detail: "The model's own words on it.", tone: "stopped", path: `/approvals#payable-${BILL(n)}`,
  pathLabel: "Decide in Approvals", txHash: null, txUrl: null, network: "arc-testnet", invoiceId: BILL(n),
});
/** Held in shadow mode for a person's verdict: the activity gives it no `invoiceId`. */
const VERDICT: ActivityItem = {
  seq: 58, text: "Decided to pay Vendor 9 120.00 USDC; it waits for your verdict in shadow mode.", detail: null, tone: "stopped", path: `/approvals#payable-${BILL(9)}`,
  pathLabel: "Give your verdict", txHash: null, txUrl: null, network: "arc-testnet",
};
const bill = (n: number, fields: Record<string, unknown> = {}) => ({
  id: BILL(n), amount: "120.00", currency: "USDC", status: "held", direction: "payable", agent_reasoning: "The invoice has no purchase order. It waits for a person.",
  counterparties: { name: `Vendor ${n}` }, ...fields,
});
type Posted = { type: string; text?: { text: string }; accessory?: { action_id: string; url: string } };
const blocksOf = (body: Record<string, unknown>) => (body.blocks ?? []) as Posted[];
/** Each bill's section in the post, as its text and its Review button's address. */
const billsOf = (body: Record<string, unknown>) =>
  blocksOf(body).filter((block) => block.accessory?.action_id === "vx_review").map((block) => [block.text?.text, block.accessory?.url]);

describe("the bills waiting for approval (docs/superpowers/specs/2026-10-27-slack-review-links-design.md SR1, SR2)", () => {
  it("tells the bills still held, flagged or waiting for details in one section of the post, each with a Review button", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([PAID, stopped(53, 1), stopped(54, 2), stopped(55, 3), stopped(56, 4), VERDICT], 60));
    invoices = [
      bill(1),
      bill(2, { status: "flagged", amount: "75.5", currency: "EURC" }),
      bill(3, { status: "awaiting_info" }),
      // Decided since the agent held it: no longer waiting.
      bill(4, { status: "paid" }),
    ];
    const { run, posts, cursor } = stage();

    expect(await run()).toEqual([{ domain: "system", message: "Told the workspace's Slack channel what the agent decided" }]);
    expect(posts).toHaveLength(1);
    const body = posts[0].body;
    expect(billsOf(body)).toEqual([
      ["*120.00 USDC* · Vendor 1 · held: The invoice has no purchase order.", `${ORIGIN}/o/acme/approvals#payable-${BILL(1)}`],
      ["*75.50 EURC* · Vendor 2 · flagged: The invoice has no purchase order.", `${ORIGIN}/o/acme/approvals#payable-${BILL(2)}`],
      ["*120.00 USDC* · Vendor 3 · waiting for details: The invoice has no purchase order.", `${ORIGIN}/o/acme/approvals#payable-${BILL(3)}`],
    ]);
    const text = JSON.stringify(body);
    expect(text).toContain("3 bills wait for approval:");
    expect(text.split("Opening a link never approves anything.")).toHaveLength(2);
    expect(text).toContain("Paid Centronex 0.35 USDC.");
    // The bill paid since is told as the decision it was; the verdict hold keeps its own block.
    expect(text).toContain("Held Vendor 4 120.00 USDC for you.");
    expect(text).toContain("Give your verdict");
    for (const n of [1, 2, 3]) expect(text).not.toContain(`Held Vendor ${n}`);
    expect(body).toMatchObject({ unfurl_links: false, unfurl_media: false });
    expect(cursor()).toEqual([60]);
  });

  it("says a bill above the figure needs two approvals, weighing a EURC bill by its USDC value, and that an accountant can co-sign", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([stopped(53, 1), stopped(54, 2), stopped(55, 3)], 60));
    invoices = [bill(1, { amount: "900" }), bill(2, { currency: "EURC", amount: "450" }), bill(3, { amount: "20" })];
    policy = [{ two_approvals_above: "500", accountant_cosigns: true }];
    usdcValueMock.mockResolvedValue(520);
    const { fake, run, posts } = stage();

    await run();

    expect(usdcValueMock).toHaveBeenCalledWith(BILL(2));
    // The figure, then the co-sign switch.
    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/approval_policies")).toHaveLength(2);
    expect(billsOf(posts[0].body).map(([text]) => text)).toEqual([
      "*900.00 USDC* · Vendor 1 · held: The invoice has no purchase order. · needs two approvals, an accountant can co-sign",
      "*450.00 EURC* · Vendor 2 · held: The invoice has no purchase order. · needs two approvals, an accountant can co-sign",
      "*20.00 USDC* · Vendor 3 · held: The invoice has no purchase order.",
    ]);
  });

  it("reads neither bills nor rules when the agent stopped none", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([PAID, VERDICT], 60));
    const { fake, run, posts } = stage();

    await run();

    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/invoices" || sent.path === "/rest/v1/approval_policies")).toEqual([]);
    expect(JSON.stringify(posts[0].body)).not.toContain("Opening a link never approves anything.");
  });

  it("still tells the decisions, each stopped bill with its own link, when the bills cannot be read", async () => {
    install = installRow();
    readActivityMock.mockResolvedValue(activity([stopped(53, 1)], 60));
    invoicesReply = { status: 500, body: { code: "XX000", message: "boom" } };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run, posts, cursor } = stage();

    expect(await run()).toHaveLength(1);

    const text = JSON.stringify(posts[0].body);
    expect(text).toContain("Held Vendor 1 120.00 USDC for you.");
    expect(text).toContain(`"action_id":"vx_open","text":{"type":"plain_text","text":"Decide in Approvals","emoji":false},"url":"${ORIGIN}/o/acme/approvals#payable-${BILL(1)}"`);
    expect(text).not.toContain("wait for approval");
    expect(cursor()).toEqual([60]);
    expect(String(error.mock.calls[0])).toContain("slack: waiting bills not read, each told as a decision");
    error.mockRestore();
  });

  it("reads no rules and draws no section while deciding from Slack is on: each waiting bill keeps its card", async () => {
    install = installRow({ decisions_limit_usdc: "1" });
    invoices = [heldInvoice()];
    readActivityMock.mockResolvedValue(activity([HELD], 57));
    const { fake, run, posts } = stage();

    await run();

    expect(fake.requests.some((sent) => sent.path === "/rest/v1/approval_policies")).toBe(false);
    const text = JSON.stringify(posts[0].body);
    expect(text).toContain("vx_approve");
    expect(text).not.toContain("vx_review");
    expect(text).not.toContain("wait for approval");
  });
});

describe("the slack stage in the cycle", () => {
  it("comes after telegram, just before discord, the last, and needs no other stage to have succeeded", () => {
    expect(CYCLE_STAGES.slice(-3)).toEqual(["telegram", "slack", "discord"]);
    expect(STAGE_REQUIRES.slack).toEqual([]);
  });
});
