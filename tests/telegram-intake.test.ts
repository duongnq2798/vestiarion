import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { addDraft, cancelDraft, readDraftForChat, type IntakeDeps } from "@/lib/telegram/intake";
import type { TelegramLink } from "@/lib/telegram/links";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { fakeTelegram } from "./support/fake-telegram";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * An invoice sent to the bot (Telegram bot design R7, R10): read only for an owner or admin, held as a draft for an
 * hour, and added once, by the member's own tap in their own chat, as the invoice form adds one. The role is read again
 * at the tap; a button pressed anywhere else adds nothing.
 */

const { runCycleSoonMock } = vi.hoisted(() => ({ runCycleSoonMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: runCycleSoonMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000171e";
const DRAFT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000d1af";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const CHAT = 5550001;
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

const LINK: TelegramLink = {
  id: LINK_ID, orgId: ORG, userId: USER, chatId: CHAT, username: "linh_ops", active: true, notifiedSeq: 40, linkedAt: "2026-10-03T08:00:00Z",
};
const STORED = {
  draft: {
    counterpartyId: COUNTERPARTIES[0].id, amount: "200.00", currency: "USDC", memo: "", poReference: "PO-1042", dueDate: "2026-10-31",
    earlyPayDiscountPct: "2", discountDeadline: "2026-10-11",
  },
  document: { kind: "pdf", sha256: "a".repeat(64), reader: "heuristic" },
};
const PDF = readFileSync(path.join(__dirname, "fixtures", "invoice-document", "northwind-inv-2207.pdf"));

let role = "owner";
let claimed: unknown[] = [STORED];

beforeEach(() => {
  role = "owner";
  claimed = [STORED];
  runCycleSoonMock.mockReset();
});

function workspace() {
  const telegram = fakeTelegram();
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/memberships") return { body: [{ role }] };
    if (sent.path === "/rest/v1/counterparties") {
      const id = sent.params.get("id");
      return { body: id ? COUNTERPARTIES.filter((row) => id === `eq.${row.id}`) : COUNTERPARTIES };
    }
    if (sent.path === "/rest/v1/telegram_drafts" && sent.method === "POST") return { body: { id: DRAFT } };
    if (sent.path === "/rest/v1/telegram_drafts" && sent.method === "PATCH") return { body: claimed };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const deps: IntakeDeps = {
    client: telegram.client,
    origin: "https://www.vestiarion.xyz",
    workspace: { slug: "northstar", name: "Northstar", mode: "sandbox" },
    now: () => new Date("2026-10-03T09:00:00Z"),
  };
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { telegram, fake, deps, run };
}

const requestsTo = (requests: RecordedRequest[], table: string, method?: string) =>
  requests.filter((sent) => sent.path === `/rest/v1/${table}` && (!method || sent.method === method));

describe("readDraftForChat", () => {
  it.each(["viewer", "approver"])("refuses a member whose role is %s before reading anything", async (lowered) => {
    role = lowered;
    const { telegram, fake, deps, run } = workspace();
    await run(() => readDraftForChat(LINK, { text: "INVOICE 200.00 USDC" }, deps));

    expect(telegram.texts()[0]).toContain("Only an owner or admin can add invoices");
    expect(requestsTo(fake.requests, "counterparties")).toEqual([]);
    expect(requestsTo(fake.requests, "telegram_drafts")).toEqual([]);
  });

  it("holds a complete invoice as a draft for an hour, and offers to add it", async () => {
    const { telegram, fake, deps, run } = workspace();
    await run(() => readDraftForChat(LINK, { bytes: new Uint8Array(PDF), name: "northwind-inv-2207.pdf", type: "application/pdf" }, deps));

    const [insert] = requestsTo(fake.requests, "telegram_drafts", "POST");
    expect(insert.body).toMatchObject({
      link_id: LINK_ID,
      draft: { counterpartyId: COUNTERPARTIES[0].id, amount: "200.00", currency: "USDC", poReference: "PO-1042", dueDate: "2026-10-31" },
      document: { kind: "pdf", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), reader: "heuristic" },
      expires_at: "2026-10-03T10:00:00.000Z",
    });
    const send = telegram.calls.find((call) => call.method === "sendMessage");
    expect(send?.args[0]).toBe(CHAT);
    expect(String(send?.args[1])).toContain("Read the invoice from Northwind Hosting");
    expect(send?.args[2]).toEqual({
      keyboard: [
        [{ text: "Add, goods received", callback_data: `add:${DRAFT}:1` }],
        [{ text: "Add, not received yet", callback_data: `add:${DRAFT}:0` }],
        [{ text: "Cancel", callback_data: `cancel:${DRAFT}` }],
      ],
    });
  });

  it("holds nothing when the counterparty is not in the workspace, and says where to add it", async () => {
    const { telegram, fake, deps, run } = workspace();
    const text = "INVOICE INV-88 from Quillfeather Studio. Amount due: 75.00 USDC. Due date: 2026-11-01. Thank you for your business.";
    await run(() => readDraftForChat(LINK, { text }, deps));

    expect(requestsTo(fake.requests, "telegram_drafts")).toEqual([]);
    expect(telegram.texts()[0]).toContain("cannot be added from here");
    expect(telegram.texts()[0]).toContain("no counterparty in this workspace matches");
    expect(telegram.texts()[0]).toContain('href="https://www.vestiarion.xyz/o/northstar/invoices"');
  });

  it("answers a document it cannot read with the reader's own words", async () => {
    const { telegram, deps, run } = workspace();
    await run(() => readDraftForChat(LINK, { bytes: new Uint8Array([1, 2, 3]), name: "photo.png", type: "image/png" }, deps));
    expect(telegram.texts()).toHaveLength(1);
    expect(telegram.texts()[0]).not.toContain("Read the invoice");
  });
});

const tap = (overrides: Partial<{ chatId: number; fromId: number; goodsReceived: boolean }> = {}) => ({
  chatId: CHAT, fromId: CHAT, messageId: 31, draftId: DRAFT, goodsReceived: true, ...overrides,
});

describe("addDraft", () => {
  it("adds the payable once, as the member, from Telegram, and starts the agent", async () => {
    const { telegram, fake, deps, run } = workspace();
    expect(await run(() => addDraft(LINK, tap(), deps))).toBe("added");

    const [claim] = requestsTo(fake.requests, "telegram_drafts", "PATCH");
    expect(claim.params.get("id")).toBe(`eq.${DRAFT}`);
    expect(claim.params.get("link_id")).toBe(`eq.${LINK_ID}`);
    expect(claim.params.get("used_at")).toBe("is.null");
    expect(claim.params.get("expires_at")).toBe("gt.2026-10-03T09:00:00.000Z");

    const [insert] = requestsTo(fake.requests, "invoices", "POST");
    expect(insert.body).toMatchObject({ counterparty_id: COUNTERPARTIES[0].id, amount: "200.00", goods_received: true, created_by: USER });
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail).toMatchObject({ via: "telegram", document: { ...STORED.document, changed: [] }, goodsReceived: true });
    expect(runCycleSoonMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: true, kind: "invoice_added" });
    expect(telegram.texts()[0]).toContain("Added");
  });

  it("adds nothing a second time, or after the hour: the claim matched nothing", async () => {
    claimed = [];
    const { telegram, fake, deps, run } = workspace();
    expect(await run(() => addDraft(LINK, tap(), deps))).toBe("used");

    expect(requestsTo(fake.requests, "invoices")).toEqual([]);
    expect(runCycleSoonMock).not.toHaveBeenCalled();
    expect(telegram.texts()[0]).toContain("already used or has expired");
  });

  it("refuses a member made a viewer since the draft was shown, and claims nothing", async () => {
    role = "viewer";
    const { telegram, fake, deps, run } = workspace();
    expect(await run(() => addDraft(LINK, tap(), deps))).toBe("refused");

    expect(requestsTo(fake.requests, "telegram_drafts")).toEqual([]);
    expect(requestsTo(fake.requests, "invoices")).toEqual([]);
    expect(telegram.texts()[0]).toContain("Only an owner or admin can add invoices");
  });

  it.each([
    ["another chat", { chatId: 9990001, fromId: 9990001 }],
    ["another person in the chat", { fromId: 9990002 }],
  ])("adds nothing for a button pressed from %s", async (_label, overrides) => {
    const { telegram, fake, deps, run } = workspace();
    expect(await run(() => addDraft(LINK, tap(overrides), deps))).toBe("ignored");
    expect(fake.requests.filter((sent) => sent.path !== "/rest/v1/orgs")).toEqual([]);
    expect(telegram.calls).toEqual([]);
  });
});

describe("cancelDraft", () => {
  it("uses the draft up, and says it was not added", async () => {
    const { telegram, fake, deps, run } = workspace();
    await run(() => cancelDraft(LINK, tap(), deps));

    expect(requestsTo(fake.requests, "telegram_drafts", "PATCH")).toHaveLength(1);
    expect(requestsTo(fake.requests, "invoices")).toEqual([]);
    expect(telegram.texts()[0]).toContain("Not added");
  });
});
