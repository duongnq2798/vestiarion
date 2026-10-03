import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/slack/interactions/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { parseMasterKeys } from "@/lib/secrets";
import { handleInteraction } from "@/lib/slack/interactions";
import { cardToken } from "@/lib/slack/state";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * A click on a card (Slack design S9, S10): verified, answered at once, decided after the response. Only a connected
 * member, only on a card Vestiarion signed for this workspace; the decision runs through the command every surface
 * shares, with the card it answers. A decision that changed the payable rewrites the message to say who did what; a
 * refusal is said to the person who clicked, and to nobody else.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { approve: vi.fn(), reject: vi.fn(), return: vi.fn(), readInvoice: vi.fn(), addDraft: vi.fn(), cancelDraft: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/commands/payables", () => ({ approvePayable: mocks.approve, rejectPayable: mocks.reject, returnPayable: mocks.return }));
vi.mock("@/lib/slack/intake", () => ({ readChosenInvoice: mocks.readInvoice, addChosenDraft: mocks.addDraft, cancelChosenDraft: mocks.cancelDraft }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c71";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c72";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c73";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c74";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-000000000c75";
const TX = `0x${"b".repeat(64)}`;
const SETTINGS = { clientId: "1.2", clientSecret: "client-secret", signingSecret: "signing-secret-for-tests" };
const RESPONSE_URL = "https://hooks.slack.com/actions/T0TEAM/1/abc";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const CARD = { org: ORG, invoice: INVOICE, decidedAt: "2026-10-03T11:58:00+00:00", addressHash: "0123456789abcdef" };
const BLOCKS = [
  { type: "section", text: { type: "mrkdwn", text: "Held Jiren 0.50 USDC for you." } },
  { type: "actions", block_id: `payable-${INVOICE}`, elements: [{ type: "button", action_id: "vx_approve" }] },
];

let linked: boolean;
let role: string;

beforeEach(() => {
  linked = true;
  role = "approver";
  for (const mock of Object.values(mocks)) mock.mockReset();
});

const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

function signedClick(actionId: string, value: string | undefined, secret = SETTINGS.signingSecret): Request {
  return signedPayload(
    {
      type: "block_actions",
      team: { id: "T0TEAM" },
      user: { id: "U0LINH", team_id: "T0TEAM" },
      response_url: RESPONSE_URL,
      message: { text: "Acme: the agent decided 1 thing", blocks: BLOCKS },
      actions: [{ action_id: actionId, block_id: `payable-${INVOICE}`, ...(value ? { value } : {}) }],
    },
    secret
  );
}

function signedPayload(payload: Record<string, unknown>, secret = SETTINGS.signingSecret): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const at = Math.floor(Date.now() / 1000);
  const signature = `v0=${crypto.createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`;
  return new Request("https://www.vestiarion.xyz/api/slack/interactions", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": signature, "x-slack-request-timestamp": String(at) },
    body,
  });
}

function world() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "acme", name: "Acme", mode: "live" }) };
    if (sent.path === "/rest/v1/slack_installs") {
      return { body: [{ id: "inst-1", org_id: ORG, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0FIN", notified_seq: 0, decisions_limit_usdc: "1", installed_at: "2026-10-03T08:00:00Z", team_name: null, channel_name: null, installed_by: null, bot_token_enc: {}, webhook_url_enc: {} }] };
    }
    if (sent.path === "/rest/v1/slack_links") return { body: linked ? [{ id: LINK_ID, org_id: ORG, user_id: USER, team_id: "T0TEAM", slack_user_id: "U0LINH", linked_at: "2026-10-03T09:00:00Z" }] : [] };
    if (sent.path === "/rest/v1/memberships") return { body: [{ role }] };
    return { body: [] };
  });
  const replies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(RESPONSE_URL);
    replies.push(JSON.parse(String(init?.body)));
    return new Response("ok");
  }) as typeof fetch;
  const deferred: Array<Promise<void>> = [];
  const handle = async (request: Request) => {
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handleInteraction(request, { settings: SETTINGS, origin: "https://www.vestiarion.xyz", fetchImpl, defer: (work) => void deferred.push(runWith({ config, db: fake.client, fetch: fake.fetch }, work)) })
    );
    await Promise.all(deferred);
    return response;
  };
  return { fake, handle, replies };
}

const ACTOR = { orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "slack", linkId: LINK_ID, decisionsLimitUsdc: 1 } };
const SHOWN = { decidedAt: CARD.decidedAt, addressHash: CARD.addressHash };

describe("the interactions route", () => {
  it("is not there when Slack is not configured", async () => {
    expect((await POST(signedClick("vx_approve", "x"))).status).toBe(404);
  });
});

describe("handleInteraction", () => {
  it("answers 401 to a click Slack did not sign, and decides nothing", async () => {
    const { fake, handle, replies } = world();
    expect((await handle(signedClick("vx_approve", cardToken(CARD, keys()), "another-secret"))).status).toBe(401);
    expect(fake.requests).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("acknowledges a link button, and does nothing more", async () => {
    const { fake, handle, replies } = world();
    expect((await handle(signedClick("vx_open", undefined))).status).toBe(200);
    expect(fake.requests).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("approves as the connected member, through Slack, with the card it answers, and rewrites the message", async () => {
    mocks.approve.mockResolvedValue({ ok: true, message: "Paid.", status: "paid", txRef: TX });
    const { handle, replies } = world();
    const response = await handle(signedClick("vx_approve", cardToken(CARD, keys())));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(mocks.approve).toHaveBeenCalledWith(ACTOR, { invoiceId: INVOICE, card: SHOWN });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ replace_original: true });
    const rewritten = JSON.stringify(replies[0]);
    expect(rewritten).toContain("Approved and paid by <@U0LINH>.");
    expect(rewritten).toContain(`https://testnet.arcscan.app/tx/${TX}`);
    expect(rewritten).not.toContain("vx_approve");
  });

  it("rejects and returns with the same card", async () => {
    mocks.reject.mockResolvedValue({ ok: true, message: "Rejected." });
    mocks.return.mockResolvedValue({ ok: true, message: "Returned." });
    const { handle, replies } = world();
    await handle(signedClick("vx_reject", cardToken(CARD, keys())));
    await handle(signedClick("vx_return", cardToken(CARD, keys())));
    expect(mocks.reject).toHaveBeenCalledWith(ACTOR, { invoiceId: INVOICE, reason: "", card: SHOWN });
    expect(mocks.return).toHaveBeenCalledWith(ACTOR, { invoiceId: INVOICE, card: SHOWN });
    expect(JSON.stringify(replies[0])).toContain("Rejected by <@U0LINH>.");
    expect(JSON.stringify(replies[1])).toContain("Returned to the agent by <@U0LINH>.");
  });

  it("says a refusal to the person who clicked alone, leaving the message as it was", async () => {
    mocks.approve.mockResolvedValue({ ok: false, code: "self_approval", message: "You created this invoice, so someone else must approve it." });
    const { handle, replies } = world();
    await handle(signedClick("vx_approve", cardToken(CARD, keys())));
    expect(replies[0]).toEqual({
      response_type: "ephemeral", replace_original: false, text: "You created this invoice, so someone else must approve it.",
    });
  });

  it("tells someone who has not connected their own account to, and decides nothing", async () => {
    linked = false;
    const { handle, replies } = world();
    await handle(signedClick("vx_approve", cardToken(CARD, keys())));
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ response_type: "ephemeral", replace_original: false });
    expect(JSON.stringify(replies[0])).toContain("/vestiarion connect");
  });

  it("refuses a card that was changed, has expired, or is another workspace's", async () => {
    const { handle, replies } = world();
    await handle(signedClick("vx_approve", `${cardToken(CARD, keys()).slice(0, -2)}AA`));
    await handle(signedClick("vx_approve", cardToken(CARD, keys(), Date.now() - 8 * 24 * 60 * 60_000)));
    await handle(signedClick("vx_approve", cardToken({ ...CARD, org: OTHER_ORG }, keys())));
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(JSON.stringify(reply)).toContain("This button no longer works");
  });
});

describe("Add invoice to Vestiarion (S15)", () => {
  const DRAFT = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d7a";
  const FILE = { id: "F0FILE", name: "invoice.pdf", mimetype: "application/pdf", size: 61_000, url_private_download: "https://files.slack.com/files-pri/T0TEAM-F0FILE/download/invoice.pdf" };
  const shortcut = (callbackId = "vx_add_invoice") =>
    signedPayload({
      type: "message_action",
      callback_id: callbackId,
      trigger_id: "1.2.abc",
      team: { id: "T0TEAM", domain: "acme" },
      user: { id: "U0LINH", team_id: "T0TEAM" },
      channel: { id: "C0FIN", name: "finance" },
      response_url: RESPONSE_URL,
      message: { type: "message", user: "U0LINH", ts: "1.2", text: "Invoice for October", files: [FILE] },
    });
  const press = (actionId: string, value: string) =>
    signedPayload({
      type: "block_actions",
      team: { id: "T0TEAM" },
      user: { id: "U0LINH", team_id: "T0TEAM" },
      response_url: RESPONSE_URL,
      container: { type: "message", is_ephemeral: true },
      actions: [{ action_id: actionId, block_id: `draft-${value}`, value }],
    });

  it("reads the chosen message after the response, as the connected member, and answers them alone", async () => {
    role = "owner";
    mocks.readInvoice.mockResolvedValue({ response_type: "ephemeral", text: "Read the invoice from Jiren." });
    const { handle, replies } = world();
    const response = await handle(shortcut());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(mocks.readInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, teamId: "T0TEAM" }),
      expect.objectContaining({ id: LINK_ID, userId: USER }),
      expect.objectContaining({ orgId: ORG, userId: USER, role: "owner", surface: { kind: "slack", linkId: LINK_ID, decisionsLimitUsdc: 1 } }),
      { files: [{ name: "invoice.pdf", mimetype: "application/pdf", size: 61_000, url: FILE.url_private_download }], text: "Invoice for October" },
      expect.objectContaining({ origin: "https://www.vestiarion.xyz", workspace: { slug: "acme", name: "Acme" } })
    );
    expect(replies).toEqual([{ response_type: "ephemeral", text: "Read the invoice from Jiren." }]);
  });

  it("tells someone who has not connected their own account to, and reads nothing", async () => {
    linked = false;
    const { handle, replies } = world();
    await handle(shortcut());
    expect(mocks.readInvoice).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ response_type: "ephemeral" });
    expect(String(replies[0].text)).toContain("Connect your Slack account to Vestiarion first");
    expect(String(replies[0].text)).toContain("Nothing was added.");
  });

  it("acknowledges a shortcut it does not know, and does nothing more", async () => {
    const { handle, replies } = world();
    expect((await handle(shortcut("vx_something_else"))).status).toBe(200);
    expect(mocks.readInvoice).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it("adds a draft from its buttons, with the goods as pressed, and drops it on Cancel", async () => {
    role = "owner";
    mocks.addDraft.mockResolvedValue({ replace_original: true, text: "Added a payable for Jiren." });
    mocks.cancelDraft.mockResolvedValue({ replace_original: true, text: "Not added." });
    const { handle, replies } = world();
    await handle(press("vx_draft_received", DRAFT));
    await handle(press("vx_draft_not_received", DRAFT));
    await handle(press("vx_draft_cancel", DRAFT));

    const actor = expect.objectContaining({ orgId: ORG, userId: USER, role: "owner" });
    expect(mocks.addDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({ orgId: ORG }), expect.objectContaining({ id: LINK_ID }), actor, { draftId: DRAFT, goodsReceived: true }, expect.anything());
    expect(mocks.addDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({ orgId: ORG }), expect.objectContaining({ id: LINK_ID }), actor, { draftId: DRAFT, goodsReceived: false }, expect.anything());
    expect(mocks.cancelDraft).toHaveBeenCalledWith(expect.objectContaining({ id: LINK_ID }), DRAFT, expect.anything());
    expect(replies.map((reply) => reply.text)).toEqual(["Added a payable for Jiren.", "Added a payable for Jiren.", "Not added."]);
  });

  it("answers a button that carries no draft without asking the database", async () => {
    const { fake, handle, replies } = world();
    await handle(press("vx_draft_received", "not-a-draft"));
    expect(mocks.addDraft).not.toHaveBeenCalled();
    expect(String(replies[0].text)).toContain("This draft was already used or has expired");
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/slack_drafts")).toBe(false);
  });
});
