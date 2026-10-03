import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { handleUpdate } from "@/lib/telegram/updates";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { fakeTelegram } from "./support/fake-telegram";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * One Telegram update, routed (Telegram bot design R3–R11): private chats only; a code connects; commands and words
 * are answered in the chat's active workspace; documents go to intake; buttons go to the draft's own link. Anything the
 * bot does not understand gets the help, and nothing throws.
 */

const { readDraftMock, addDraftMock, cancelDraftMock, routeTextMock } = vi.hoisted(() => ({
  readDraftMock: vi.fn(),
  addDraftMock: vi.fn(),
  cancelDraftMock: vi.fn(),
  routeTextMock: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: vi.fn() }));
vi.mock("@/lib/telegram/intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram/intake")>()),
  readDraftForChat: readDraftMock,
  addDraft: addDraftMock,
  cancelDraft: cancelDraftMock,
}));
vi.mock("@/lib/telegram/route-text", () => ({ routeText: routeTextMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ORG_2 = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const LINK_A = "0b6c1c9e-4a4f-4a7e-9b1e-00000000171a";
const LINK_B = "0b6c1c9e-4a4f-4a7e-9b1e-00000000171b";
const DRAFT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000d1af";
const CHAT = 5550001;
const CODE = "C".repeat(43);
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const linkRow = (id: string, orgId: string, active: boolean) => ({
  id, org_id: orgId, user_id: USER, chat_id: CHAT, username: "linh_ops", active, notified_seq: 40, linked_at: "2026-10-03T08:00:00Z",
});

let links: Array<ReturnType<typeof linkRow>> = [];
let claimed: Array<ReturnType<typeof linkRow>> = [];
let role = "owner";

beforeEach(() => {
  links = [linkRow(LINK_A, ORG, true), linkRow(LINK_B, ORG_2, false)];
  claimed = [];
  role = "owner";
  for (const mock of [readDraftMock, addDraftMock, cancelDraftMock, routeTextMock]) mock.mockReset();
  addDraftMock.mockResolvedValue("added");
});

function bot(answer?: Parameters<typeof fakeTelegram>[0]) {
  const telegram = fakeTelegram(answer);
  const fake = fakeSupabase((sent: RecordedRequest) => {
    const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    switch (sent.path) {
      case "/rest/v1/rpc/telegram_claim_code":
        return { body: claimed };
      case "/rest/v1/rpc/telegram_activate":
        return { body: links.filter((link) => link.id === (sent.body as { p_link_id: string }).p_link_id) };
      case "/rest/v1/telegram_links":
        if (sent.method === "DELETE") return { body: [{ id: sent.params.get("id")?.slice(3) }] };
        return { body: sent.method === "GET" ? links : [] };
      case "/rest/v1/memberships":
        return { body: [{ role }] };
      case "/rest/v1/orgs": {
        const id = sent.params.get("id");
        const row = id === `eq.${ORG_2}` ? orgs.orgRow(ORG_2, { slug: "second", name: "Second Co" }) : orgs.orgRow(ORG);
        return { body: wantsObject ? row : [orgs.orgRow(ORG), orgs.orgRow(ORG_2, { slug: "second", name: "Second Co" })] };
      }
      case "/rest/v1/telegram_drafts":
        return { body: [{ link_id: LINK_B }] };
      case "/rest/v1/rpc/append_ledger_entry":
        return { body: APPENDED_LEDGER_ROW };
      default:
        return { body: [] };
    }
  });
  const handle = (update: unknown) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () => handleUpdate(update, { client: telegram.client, origin: "https://www.vestiarion.xyz" }));
  return { telegram, fake, handle };
}

let updateId = 1;
const message = (fields: Record<string, unknown>, chat: { id: number; type: string } = { id: CHAT, type: "private" }) => ({
  update_id: updateId++,
  message: { message_id: 10, date: 1, chat, from: { id: chat.id, is_bot: false, first_name: "Linh", username: "linh_ops" }, ...fields },
});

const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => (sent.body as { p_action: string }).p_action);

describe("handleUpdate: messages", () => {
  it("answers a group once, that it works in a private chat, and reads nothing", async () => {
    const { telegram, fake, handle } = bot();
    await handle(message({ text: "/today" }, { id: -100200, type: "supergroup" }));

    expect(telegram.calls).toEqual([{ method: "sendMessage", args: [-100200, expect.stringContaining("private chat")] }]);
    expect(fake.requests).toEqual([]);
  });

  it("connects the chat with a code, and records it in the workspace's ledger", async () => {
    claimed = [linkRow(LINK_A, ORG, true)];
    const { telegram, fake, handle } = bot();
    await handle(message({ text: `/start ${CODE}` }));

    expect(fake.requests.find((sent) => sent.path === "/rest/v1/rpc/telegram_claim_code")?.body).toMatchObject({ p_chat_id: CHAT, p_username: "linh_ops" });
    expect(ledger(fake.requests)).toEqual(["telegram_connected"]);
    expect(telegram.texts()[0]).toContain("Connected to <b>Northstar</b>");
  });

  it("says a used or expired code connects nothing, and records nothing", async () => {
    const { telegram, fake, handle } = bot();
    await handle(message({ text: `/start ${CODE}` }));

    expect(ledger(fake.requests)).toEqual([]);
    expect(telegram.texts()[0]).toContain("already used or has expired");
    expect(telegram.texts()[0]).toContain("open <b>Settings</b>");
  });

  it("tells a chat with no link how to connect one, whatever it asks", async () => {
    links = [];
    const { telegram, handle } = bot();
    await handle(message({ text: "/today" }));
    await handle(message({ text: "how much can we spend?" }));

    expect(telegram.texts()).toHaveLength(2);
    for (const text of telegram.texts()) expect(text).toContain("not connected");
    expect(routeTextMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a sticker", { sticker: { file_id: "s" } }],
    ["a voice note", { voice: { file_id: "v", duration: 2 } }],
    ["a location", { location: { latitude: 21.0, longitude: 105.8 } }],
  ])("answers %s with the help", async (_label, fields) => {
    const { telegram, handle } = bot();
    await handle(message(fields));
    expect(telegram.texts()).toEqual([expect.stringContaining("/today")]);
  });

  it("asks for the PDF or the text when sent a photo", async () => {
    const { telegram, handle } = bot();
    await handle(message({ photo: [{ file_id: "p", width: 1, height: 1 }] }));
    expect(telegram.texts()[0]).toContain("Send the invoice as a PDF, or paste its text");
    expect(readDraftMock).not.toHaveBeenCalled();
  });

  it("does nothing with a message from no one, or an update it does not understand", async () => {
    const { telegram, fake, handle } = bot();
    await handle({ update_id: 5, message: { message_id: 1, date: 1, chat: { id: CHAT, type: "private" }, text: "/today" } });
    await handle({ update_id: 6, edited_message: { text: "x" } });
    await handle("not an update");
    expect(telegram.calls).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a viewer's document before fetching it", async () => {
    role = "viewer";
    const { telegram, handle } = bot();
    await handle(message({ document: { file_id: "d", file_name: "inv.pdf", mime_type: "application/pdf", file_size: 1200 } }));

    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(telegram.texts()[0]).toContain("Only an owner or admin can add invoices");
    expect(readDraftMock).not.toHaveBeenCalled();
  });

  it("refuses a document over 4 MB before fetching it", async () => {
    const { telegram, handle } = bot();
    await handle(message({ document: { file_id: "d", file_name: "big.pdf", mime_type: "application/pdf", file_size: 4_000_001 } }));

    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(telegram.texts()[0]).toContain("4 MB");
    expect(readDraftMock).not.toHaveBeenCalled();
  });

  it("fetches a document and hands it to intake for the active workspace", async () => {
    const { handle } = bot((call) =>
      call.method === "getFile"
        ? { ok: true, result: { file_path: "documents/file_3.pdf", file_size: 1200 } }
        : call.method === "download"
          ? { ok: true, result: new Uint8Array([37, 80, 68, 70]) }
          : { ok: true, result: { message_id: 99 } }
    );
    await handle(message({ document: { file_id: "d", file_name: "inv.pdf", mime_type: "application/pdf", file_size: 1200 } }));

    expect(readDraftMock).toHaveBeenCalledTimes(1);
    const [link, input, deps] = readDraftMock.mock.calls[0];
    expect(link).toMatchObject({ id: LINK_A, orgId: ORG });
    expect(input).toEqual({ bytes: new Uint8Array([37, 80, 68, 70]), name: "inv.pdf", type: "application/pdf" });
    expect(deps.workspace).toEqual({ slug: "northstar", name: "Northstar", mode: "sandbox" });
  });

  it("routes plain words, and hands an invoice's text to intake", async () => {
    routeTextMock.mockResolvedValue({ intent: "invoice", mode: "heuristic" });
    const { handle } = bot();
    await handle(message({ text: "INVOICE 42 from Northwind Hosting, 200.00 USDC due 2026-10-31" }));

    expect(readDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: LINK_A }),
      { text: "INVOICE 42 from Northwind Hosting, 200.00 USDC due 2026-10-31" },
      expect.anything()
    );
  });

  it("lists the chat's workspaces as buttons, the active one marked", async () => {
    const { telegram, handle } = bot();
    await handle(message({ text: "/workspaces" }));

    const send = telegram.calls.find((call) => call.method === "sendMessage");
    expect(send?.args[2]).toEqual({
      keyboard: [[{ text: "✓ Northstar", callback_data: `use:${LINK_A}` }], [{ text: "Second Co", callback_data: `use:${LINK_B}` }]],
    });
  });

  it("disconnects the active workspace, records it, and moves commands to the next one", async () => {
    const { telegram, fake, handle } = bot();
    await handle(message({ text: "/disconnect" }));

    expect(fake.requests.some((sent) => sent.path === "/rest/v1/telegram_links" && sent.method === "DELETE" && sent.params.get("id") === `eq.${LINK_A}`)).toBe(true);
    expect(ledger(fake.requests)).toEqual(["telegram_disconnected"]);
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/rpc/telegram_activate")?.body).toEqual({ p_chat_id: CHAT, p_link_id: LINK_B });
    expect(telegram.texts()[0]).toContain("Disconnected from <b>Northstar</b>");
  });

  it("says where to connect again once the chat's last workspace is disconnected", async () => {
    links = [linkRow(LINK_A, ORG, true)];
    const { telegram, handle } = bot();
    await handle(message({ text: "/disconnect" }));

    expect(telegram.texts()[0]).toContain("To connect it again, press <b>Connect Telegram</b> in its Settings, under Notifications.");
  });
});

describe("handleUpdate: buttons", () => {
  const press = (data: string, from = CHAT, chat: { id: number; type: string } = { id: CHAT, type: "private" }) => ({
    update_id: updateId++,
    callback_query: { id: "cb-1", from: { id: from, is_bot: false, first_name: "Linh" }, data, message: { message_id: 31, date: 1, chat } },
  });

  it("adds a draft through the draft's own link, which need not be the active one, and answers the press", async () => {
    const { telegram, handle } = bot();
    await handle(press(`add:${DRAFT}:1`));

    expect(addDraftMock).toHaveBeenCalledTimes(1);
    const [link, tap] = addDraftMock.mock.calls[0];
    expect(link).toMatchObject({ id: LINK_B, orgId: ORG_2 });
    expect(tap).toEqual({ chatId: CHAT, fromId: CHAT, messageId: 31, draftId: DRAFT, goodsReceived: true });
    expect(telegram.calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
  });

  it("switches the active workspace", async () => {
    const { telegram, handle } = bot();
    await handle(press(`use:${LINK_B}`));
    expect(telegram.texts()[0]).toContain("now go to <b>Second Co</b>");
  });

  it("only answers a press from a group", async () => {
    const { telegram, fake, handle } = bot();
    await handle(press(`add:${DRAFT}:1`, 777, { id: -100200, type: "group" }));

    expect(addDraftMock).not.toHaveBeenCalled();
    expect(telegram.calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
    expect(fake.requests).toEqual([]);
  });
});
