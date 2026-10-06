import { z } from "zod";
import { can } from "../auth/roles";
import { platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { MAX_DOCUMENT_BYTES } from "../invoice-document/read";
import { verifyLedger } from "../ledger";
import { takeTelegramChatToken } from "../rate-limit";
import type { InlineButton, TelegramClient } from "./client";
import { addDraft, cancelDraft, readDraftForChat, roleRefusal, type IntakeDeps } from "./intake";
import {
  activateLink, activeLink, claimLinkCode, disconnect, linksForChat, memberRole, recordConnected, workspaceOf, type TelegramLink, type Workspace,
} from "./links";
import { escapeHtml, helpMessage, ledgerMessage, orgUrl, PRIVATE_ONLY, todayMessage, waitingMessage } from "./messages";
import { routeText } from "./route-text";
import { todayFacts, waitingFacts } from "./today";
import { workspaceNetwork } from "../workspace-network";

/**
 * One update from Telegram, routed (Telegram bot design R3–R11). Only a private chat is served. `/start <code>`
 * connects it; everything else is answered in the chat's active workspace, inside that workspace's scope, after the
 * member's role is read afresh. A button acts through the link its draft or workspace belongs to. The bot answers
 * what it does not understand with its help, and never throws for a malformed update.
 */

export interface UpdateDeps {
  client: TelegramClient;
  origin: string;
  now?: () => Date;
}

const chatSchema = z.object({ id: z.number(), type: z.string() });
const userSchema = z.object({ id: z.number(), username: z.string().optional() });
const messageSchema = z.object({
  message_id: z.number(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
  document: z
    .object({ file_id: z.string(), file_name: z.string().optional(), mime_type: z.string().optional(), file_size: z.number().optional() })
    .optional(),
  photo: z.array(z.unknown()).optional(),
});
const callbackSchema = z.object({
  id: z.string(),
  from: userSchema,
  data: z.string().optional(),
  message: z.object({ message_id: z.number(), chat: chatSchema }).optional(),
});
const updateSchema = z.object({ update_id: z.number(), message: messageSchema.optional(), callback_query: callbackSchema.optional() });

type Message = z.output<typeof messageSchema>;
type Callback = z.output<typeof callbackSchema>;

const TOO_LARGE = "That file is over 4 MB. Send a smaller PDF, or paste the invoice's text.";
const NOT_FETCHED = "That file could not be fetched from Telegram. Send it again in a moment.";
const PHOTO = "Send the invoice as a PDF, or paste its text. Photos are not read.";
const FAILED = "That did not work. Try again in a moment.";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export async function handleUpdate(update: unknown, deps: UpdateDeps): Promise<void> {
  const parsed = updateSchema.safeParse(update);
  if (!parsed.success) return;
  const { message, callback_query: callback } = parsed.data;
  if (message) {
    try {
      await handleMessage(message, deps);
    } catch (error) {
      console.error("telegram: message not handled", parsed.data.update_id, error instanceof Error ? error.message : "unknown error");
      if (message.chat.type === "private") await deps.client.sendMessage(message.chat.id, FAILED);
    }
  } else if (callback) {
    await handleCallback(callback, deps);
  }
}

async function handleMessage(message: Message, deps: UpdateDeps): Promise<void> {
  const { client } = deps;
  const chatId = message.chat.id;
  if (message.chat.type !== "private") {
    await client.sendMessage(chatId, PRIVATE_ONLY);
    return;
  }
  if (!message.from || !takeTelegramChatToken(String(chatId))) return;

  const text = message.text?.trim() ?? "";
  const start = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
  if (start) {
    await connect(chatId, start[1], message.from.username ?? null, deps);
    return;
  }

  const link = await activeLink(chatId);
  const role = link ? await memberRole(link.orgId, link.userId) : null;
  if (!link || !role) {
    await client.sendMessage(chatId, helpMessage(false));
    return;
  }
  const workspace = await workspaceOf(link.orgId);
  const intake: IntakeDeps = { client, origin: deps.origin, workspace, now: deps.now };
  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;

  await withOrg(
    link.orgId,
    async () => {
      if (command === "today" || command === "waiting" || command === "ledger") return answer(command, chatId, workspace, deps);
      if (command === "workspaces") return listWorkspaces(chatId, client);
      if (command === "disconnect") return disconnectChat(link, workspace, deps);
      if (command) return void (await client.sendMessage(chatId, helpMessage(true, workspace.name)));

      if (message.document) {
        if (!can(role, "records.write")) return void (await client.sendMessage(chatId, roleRefusal(role, workspace.name)));
        return receiveDocument(link, message.document, intake);
      }
      if (message.photo) return void (await client.sendMessage(chatId, PHOTO));
      if (!text) return void (await client.sendMessage(chatId, helpMessage(true, workspace.name)));

      const { intent } = await routeText(text, workspaceNetwork().id);
      if (intent === "invoice") return readDraftForChat(link, { text }, intake);
      if (intent === "help") return void (await client.sendMessage(chatId, helpMessage(true, workspace.name)));
      return answer(intent, chatId, workspace, deps);
    },
    { userId: link.userId }
  );
}

/** `/start <code>` (R4): claims the code for this chat, records the connection, and says what the chat now gets. */
async function connect(chatId: number, code: string, username: string | null, deps: UpdateDeps): Promise<void> {
  const link = await claimLinkCode(code, chatId, username);
  if (!link) {
    await deps.client.sendMessage(
      chatId,
      "This link was already used or has expired. In Vestiarion, open <b>Settings</b> and press <b>Connect Telegram</b> for a new one."
    );
    return;
  }
  const workspace = await workspaceOf(link.orgId);
  try {
    await withOrg(link.orgId, () => recordConnected(link), { userId: link.userId });
  } catch (error) {
    // The chat is connected either way; the missing entry is logged rather than kept from the member.
    console.error("telegram: connection not recorded", link.orgId, error instanceof Error ? error.message : "unknown error");
  }
  await deps.client.sendMessage(chatId, helpMessage(true, workspace.name));
}

/** /today, /waiting and /ledger (R9): read and written by code, in the workspace's scope. */
async function answer(question: "today" | "waiting" | "ledger", chatId: number, workspace: Workspace, deps: UpdateDeps): Promise<void> {
  const { client, origin } = deps;
  if (question === "today") {
    await client.sendMessage(chatId, todayMessage(workspace.name, await todayFacts(), orgUrl(origin, workspace.slug, "/console")));
  } else if (question === "waiting") {
    await client.sendMessage(chatId, waitingMessage(workspace.name, await waitingFacts(), origin, workspace.slug));
  } else {
    await client.sendMessage(chatId, ledgerMessage(workspace.name, await verifyLedger()));
  }
}

/** /workspaces (R5): every workspace the chat is connected to, as buttons, the active one marked. */
async function listWorkspaces(chatId: number, client: TelegramClient): Promise<void> {
  const links = await linksForChat(chatId);
  const rows = unwrap(
    await platformDb()
      .from("orgs")
      .select("id, name")
      .in("id", links.map((link) => link.orgId))
  ) as Array<{ id: string; name: string }>;
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const keyboard: InlineButton[][] = links.map((link) => [
    { text: `${link.active ? "✓ " : ""}${names.get(link.orgId) ?? "A workspace"}`, callback_data: `use:${link.id}` },
  ]);
  await client.sendMessage(chatId, "Your connected workspaces. Commands and invoices go to the one marked ✓; tap another to switch.", { keyboard });
}

/** /disconnect (R6): the active workspace stops telling this chat; the next connected one, if any, becomes active. */
async function disconnectChat(link: TelegramLink, workspace: Workspace, deps: UpdateDeps): Promise<void> {
  const removed = await disconnect(link, "telegram", link.userId);
  const next = (await linksForChat(link.chatId)).find((other) => other.id !== link.id);
  const activated = next ? await activateLink(link.chatId, next.id) : null;
  const nextName = activated ? (await workspaceOf(activated.orgId)).name : null;
  await deps.client.sendMessage(
    link.chatId,
    `${removed ? "Disconnected from" : "This chat was already disconnected from"} <b>${escapeHtml(workspace.name)}</b>. Its decisions are no longer sent here.` +
      (nextName
        ? ` Commands and invoices now go to <b>${escapeHtml(nextName)}</b>.`
        : " To connect it again, press <b>Connect Telegram</b> in its Settings, under Notifications.")
  );
}

/** A document sent to the bot: fetched from Telegram within the size limit, then read by intake (R10). */
async function receiveDocument(link: TelegramLink, document: NonNullable<Message["document"]>, intake: IntakeDeps): Promise<void> {
  const { client } = intake;
  if ((document.file_size ?? 0) > MAX_DOCUMENT_BYTES) {
    await client.sendMessage(link.chatId, TOO_LARGE);
    return;
  }
  const file = await client.getFile(document.file_id);
  if (!file.ok || !file.result.file_path) {
    await client.sendMessage(link.chatId, NOT_FETCHED);
    return;
  }
  if ((file.result.file_size ?? 0) > MAX_DOCUMENT_BYTES) {
    await client.sendMessage(link.chatId, TOO_LARGE);
    return;
  }
  const bytes = await client.download(file.result.file_path);
  if (!bytes.ok) {
    await client.sendMessage(link.chatId, NOT_FETCHED);
    return;
  }
  if (bytes.result.byteLength > MAX_DOCUMENT_BYTES) {
    await client.sendMessage(link.chatId, TOO_LARGE);
    return;
  }
  await readDraftForChat(link, { bytes: bytes.result, name: document.file_name ?? "document", type: document.mime_type ?? "" }, intake);
}

/** The chat's link a draft was read for: the draft's own workspace, which need not be the active one. */
async function draftLink(chatId: number, draftId: string): Promise<TelegramLink | null> {
  const rows = unwrap(await platformDb().from("telegram_drafts").select("link_id").eq("id", draftId).limit(1)) as Array<{ link_id: string }>;
  const linkId = rows[0]?.link_id;
  return linkId ? ((await linksForChat(chatId)).find((link) => link.id === linkId) ?? null) : null;
}

async function handleCallback(callback: Callback, deps: UpdateDeps): Promise<void> {
  const { client } = deps;
  const chat = callback.message?.chat;
  try {
    if (!chat || !callback.message || chat.type !== "private" || !takeTelegramChatToken(String(chat.id))) return;
    const messageId = callback.message.message_id;
    const data = callback.data ?? "";
    const add = new RegExp(`^add:(${UUID}):([01])$`).exec(data);
    const cancel = new RegExp(`^cancel:(${UUID})$`).exec(data);
    const use = new RegExp(`^use:(${UUID})$`).exec(data);

    if (add || cancel) {
      const draftId = (add ?? cancel)![1];
      const link = await draftLink(chat.id, draftId);
      if (!link) {
        await client.editMessageText(chat.id, messageId, "This draft's workspace is no longer connected to this chat.");
        return;
      }
      const intake: IntakeDeps = { client, origin: deps.origin, workspace: await workspaceOf(link.orgId), now: deps.now };
      const tap = { chatId: chat.id, fromId: callback.from.id, messageId, draftId };
      await withOrg(
        link.orgId,
        async () => {
          if (add) await addDraft(link, { ...tap, goodsReceived: add[2] === "1" }, intake);
          else await cancelDraft(link, tap, intake);
        },
        { userId: link.userId }
      );
      return;
    }
    if (use) {
      const link = await activateLink(chat.id, use[1]);
      await client.editMessageText(
        chat.id,
        messageId,
        link
          ? `Commands and invoices now go to <b>${escapeHtml((await workspaceOf(link.orgId)).name)}</b>.`
          : "That workspace is no longer connected to this chat."
      );
    }
  } catch (error) {
    console.error("telegram: button not handled", error instanceof Error ? error.message : "unknown error");
  } finally {
    await client.answerCallbackQuery(callback.id);
  }
}
