import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/commands/actor";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import type { SlackInstall } from "@/lib/slack/installs";
import { addChosenDraft, cancelChosenDraft, readChosenInvoice, type ChosenMessage, type SlackIntakeDeps } from "@/lib/slack/intake";
import type { SlackLink } from "@/lib/slack/links";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * An invoice chosen in Slack with "Add invoice" (Slack design S15): read only for an owner or admin, from
 * Slack's own file host with the install's token once the install may read files, held as a draft for an hour, and
 * added once, by the member's own press, as the invoice form adds one, with the entry naming Slack and the link.
 */

const { runCycleSoonMock } = vi.hoisted(() => ({ runCycleSoonMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: runCycleSoonMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000181e";
const DRAFT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000d2af";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a2";
const FILE_URL = "https://files.slack.com/files-pri/T0TEAM-F0FILE/download/northwind-inv-2207.pdf";
const COUNTERPARTIES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting", role: "vendor", address: null },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0df", name: "Harbor Office Supply", role: "vendor", address: null },
];
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
/** The master keys `signedOrgs` puts in place while each test runs. */
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

const PDF = readFileSync(path.join(__dirname, "fixtures", "invoice-document", "northwind-inv-2207.pdf"));
const LINK: SlackLink = { id: LINK_ID, orgId: ORG, userId: USER, teamId: "T0TEAM", slackUserId: "U0LINH", linkedAt: "2026-10-03T08:00:00Z" };
const STORED = {
  draft: {
    counterpartyId: COUNTERPARTIES[0].id, amount: "200.00", currency: "USDC", memo: "", poReference: "PO-1042", dueDate: "2026-10-31",
    earlyPayDiscountPct: "2", discountDeadline: "2026-10-11",
  },
  document: { kind: "pdf", sha256: "a".repeat(64), reader: "heuristic" },
};

function install(scopes: string[] = ["commands", "incoming-webhook", "files:read"]): SlackInstall {
  const envelope = encryptSecret("xoxb-1-2-abc", { orgId: ORG, column: "slack_installs.bot_token_enc" }, keys());
  return {
    id: "inst-1", orgId: ORG, teamId: "T0TEAM", teamName: "Northstar", appId: "A0APP", botUserId: "U0BOT", channelId: "C0FINANCE", channelName: "#finance",
    installedBy: USER, installedAt: "2026-10-03T08:00:00Z", notifiedSeq: 40, decisionsLimitUsdc: null, scopes, botTokenEnc: envelope, webhookUrlEnc: envelope,
  };
}

const actor = (role: Actor["role"] = "owner"): Actor => ({
  orgId: ORG, userId: USER, role, mode: "sandbox", surface: { kind: "slack", linkId: LINK_ID, decisionsLimitUsdc: null },
});

const pdfMessage = (file: Partial<ChosenMessage["files"][number]> = {}): ChosenMessage => ({
  files: [{ name: "northwind-inv-2207.pdf", mimetype: "application/pdf", size: PDF.length, url: FILE_URL, ...file }],
  text: "",
});

let claimed: unknown[] = [STORED];

beforeEach(() => {
  claimed = [STORED];
  runCycleSoonMock.mockReset();
});

function workspace() {
  const downloads: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    downloads.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(new Blob([new Uint8Array(PDF)]), { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/counterparties") {
      const id = sent.params.get("id");
      return { body: id ? COUNTERPARTIES.filter((row) => id === `eq.${row.id}`) : COUNTERPARTIES };
    }
    if (sent.path === "/rest/v1/slack_drafts" && sent.method === "POST") return { body: { id: DRAFT } };
    if (sent.path === "/rest/v1/slack_drafts" && sent.method === "PATCH") return { body: claimed };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const deps: SlackIntakeDeps = {
    origin: "https://www.vestiarion.xyz",
    workspace: { slug: "northstar", name: "Northstar" },
    fetchImpl,
    keys: keys(),
    now: () => new Date("2026-10-03T09:00:00Z"),
  };
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, deps, downloads, run };
}

const requestsTo = (requests: RecordedRequest[], table: string, method?: string) =>
  requests.filter((sent) => sent.path === `/rest/v1/${table}` && (!method || sent.method === method));
const textOf = (message: { text: string; blocks?: unknown[] }) => JSON.stringify(message);
const buttons = (message: { blocks?: unknown[] }) =>
  (message.blocks ?? []).flatMap((block) => ((block as { type: string; elements?: unknown[] }).type === "actions" ? (block as { elements: unknown[] }).elements : [])) as Array<{
    action_id: string;
    value?: string;
    text: { text: string };
  }>;

describe("readChosenInvoice", () => {
  it.each(["viewer", "approver"] as const)("refuses a member whose role is %s before reading anything", async (role) => {
    const { fake, deps, downloads, run } = workspace();
    const answer = await run(() => readChosenInvoice(install(), LINK, actor(role), pdfMessage(), deps));

    expect(answer.response_type).toBe("ephemeral");
    expect(answer.text).toContain("Only an owner or admin can add invoices");
    expect(downloads).toEqual([]);
    expect(requestsTo(fake.requests, "counterparties")).toEqual([]);
  });

  it("asks for Slack to be connected again before it can open a file, and opens nothing", async () => {
    const { deps, downloads, run } = workspace();
    const answer = await run(() => readChosenInvoice(install(["commands", "incoming-webhook"]), LINK, actor(), pdfMessage(), deps));

    expect(answer.text).toContain("Reconnect Slack");
    expect(downloads).toEqual([]);
  });

  it("tries to open the file for an install made before its permissions were kept, and asks to reconnect only if Slack refuses", async () => {
    const opened = workspace();
    const answer = await opened.run(() => readChosenInvoice(install([]), LINK, actor(), pdfMessage(), opened.deps));
    expect(opened.downloads).toHaveLength(1);
    expect(textOf(answer)).toContain("Read the invoice from Northwind Hosting");

    const refused = workspace();
    const withheld = { ...refused.deps, fetchImpl: (async () => new Response("forbidden", { status: 403 })) as typeof fetch };
    const reconnect = await refused.run(() => readChosenInvoice(install([]), LINK, actor(), pdfMessage(), withheld));
    expect(reconnect.text).toContain("Reconnect Slack");
  });

  it("reads the chosen PDF from Slack's file host and holds it as a draft for an hour, offering to add it", async () => {
    const { fake, deps, downloads, run } = workspace();
    const answer = await run(() => readChosenInvoice(install(), LINK, actor(), pdfMessage(), deps));

    expect(downloads).toEqual([{ url: FILE_URL, authorization: "Bearer xoxb-1-2-abc" }]);
    const [insert] = requestsTo(fake.requests, "slack_drafts", "POST");
    expect(insert.body).toMatchObject({
      link_id: LINK_ID,
      draft: { counterpartyId: COUNTERPARTIES[0].id, amount: "200.00", currency: "USDC", poReference: "PO-1042", dueDate: "2026-10-31" },
      document: { kind: "pdf", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), reader: "heuristic" },
      expires_at: "2026-10-03T10:00:00.000Z",
    });
    expect(answer.response_type).toBe("ephemeral");
    expect(textOf(answer)).toContain("Read the invoice from Northwind Hosting");
    expect(buttons(answer).map((button) => [button.action_id, button.text.text, button.value])).toEqual([
      ["vx_draft_received", "Add, goods received", DRAFT],
      ["vx_draft_not_received", "Add, not received yet", DRAFT],
      ["vx_draft_cancel", "Cancel", DRAFT],
    ]);
  });

  it("reads the message's own text when it holds no file, without opening anything", async () => {
    const { fake, deps, downloads, run } = workspace();
    const text = "INVOICE INV-88 from Quillfeather Studio. Amount due: 75.00 USDC. Due date: 2026-11-01. Thank you for your business.";
    const answer = await run(() => readChosenInvoice(install(["commands"]), LINK, actor(), { files: [], text }, deps));

    expect(downloads).toEqual([]);
    expect(requestsTo(fake.requests, "slack_drafts")).toEqual([]);
    expect(textOf(answer)).toContain("cannot be added from here");
    expect(textOf(answer)).toContain("no counterparty in this workspace matches");
    expect(textOf(answer)).toContain("https://www.vestiarion.xyz/o/northstar/invoices");
  });

  it("says what it can read when the message holds neither an invoice file nor text", async () => {
    const { deps, downloads, run } = workspace();
    const photo = await run(() => readChosenInvoice(install(), LINK, actor(), pdfMessage({ name: "photo.png", mimetype: "image/png" }), deps));
    expect(photo.text).toContain("Choose a PDF, a .txt or an .eml file");
    const empty = await run(() => readChosenInvoice(install(), LINK, actor(), { files: [], text: "  " }, deps));
    expect(empty.text).toContain("Choose a PDF, a .txt or an .eml file");
    expect(downloads).toEqual([]);
  });

  it("refuses a file over 4 MB without opening it", async () => {
    const { deps, downloads, run } = workspace();
    const answer = await run(() => readChosenInvoice(install(), LINK, actor(), pdfMessage({ size: 5_000_000 }), deps));
    expect(answer.text).toContain("at most 4 MB");
    expect(downloads).toEqual([]);
  });

  it("says to invite Vestiarion to the channel when Slack withholds a file the install may read", async () => {
    const { deps, run } = workspace();
    const refused = { ...deps, fetchImpl: (async () => new Response("forbidden", { status: 403 })) as typeof fetch };
    const answer = await run(() => readChosenInvoice(install(), LINK, actor(), pdfMessage(), refused));
    expect(answer.text).toContain("/invite @Vestiarion");
    expect(answer.text).not.toContain("Reconnect Slack");
  });

  it("opens only Slack's own file host", async () => {
    const { deps, downloads, run } = workspace();
    const answer = await run(() => readChosenInvoice(install(), LINK, actor(), pdfMessage({ url: "https://example.com/invoice.pdf" }), deps));
    expect(answer.text).toContain("could not be opened");
    expect(downloads).toEqual([]);
  });
});

describe("addChosenDraft", () => {
  it("adds the draft once, as the member, naming Slack and the link, and starts the agent", async () => {
    const { fake, deps, run } = workspace();
    const answer = await run(() => addChosenDraft(install(), LINK, actor(), { draftId: DRAFT, goodsReceived: false }, deps));

    const [claim] = requestsTo(fake.requests, "slack_drafts", "PATCH");
    expect(claim.params.get("id")).toBe(`eq.${DRAFT}`);
    expect(claim.params.get("link_id")).toBe(`eq.${LINK_ID}`);
    expect(claim.params.get("used_at")).toBe("is.null");
    expect(claim.params.get("expires_at")).toBe("gt.2026-10-03T09:00:00.000Z");
    const [insert] = requestsTo(fake.requests, "invoices", "POST");
    expect(insert.body).toMatchObject({ direction: "payable", counterparty_id: COUNTERPARTIES[0].id, amount: "200.00", goods_received: false, created_by: USER });
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_action: string; p_detail: Record<string, unknown> };
    expect(entry.p_action).toBe("create_invoice");
    expect(entry.p_detail).toMatchObject({ by: USER, via: "slack", linkId: LINK_ID, document: { kind: "pdf", changed: [] } });
    expect(runCycleSoonMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: true, kind: "invoice_added" });
    expect(answer.replace_original).toBe(true);
    expect(answer.text).toContain("Added a payable for Northwind Hosting");
    expect(answer.text).toContain("#finance");
  });

  it("adds nothing for a draft already used or expired", async () => {
    claimed = [];
    const { fake, deps, run } = workspace();
    const answer = await run(() => addChosenDraft(install(), LINK, actor(), { draftId: DRAFT, goodsReceived: true }, deps));
    expect(answer.text).toContain("This draft was already used or has expired");
    expect(requestsTo(fake.requests, "invoices")).toEqual([]);
  });

  it("refuses a member who may no longer add invoices, and leaves the draft for someone who may", async () => {
    const { fake, deps, run } = workspace();
    const answer = await run(() => addChosenDraft(install(), LINK, actor("approver"), { draftId: DRAFT, goodsReceived: true }, deps));
    expect(answer.text).toContain("Only an owner or admin can add invoices");
    expect(requestsTo(fake.requests, "slack_drafts")).toEqual([]);
  });
});

describe("cancelChosenDraft", () => {
  it("drops the draft unused", async () => {
    const { fake, deps, run } = workspace();
    const answer = await run(() => cancelChosenDraft(LINK, DRAFT, deps));
    expect(requestsTo(fake.requests, "slack_drafts", "PATCH")).toHaveLength(1);
    expect(answer).toMatchObject({ replace_original: true, text: "Not added." });
  });
});
