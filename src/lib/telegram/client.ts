import type { TelegramSettings } from "./settings";

/**
 * The few Bot API calls the bot makes (Telegram bot design §6), over `fetch`. Every call answers `ok` with Telegram's
 * result, or the HTTP status and Telegram's description (status 0 when the network failed): it never throws, so a
 * caller decides what a 403 or a 400 means. The token is part of every URL and is scrubbed from any description.
 */

export type InlineButton = { text: string; url: string } | { text: string; callback_data: string };

export type TelegramResult<T> = { ok: true; result: T } | { ok: false; status: number; description: string };

export interface SendOptions {
  keyboard?: InlineButton[][];
  /** Sends the text as it is, with no HTML formatting: the fallback for a message Telegram refused to parse. */
  plain?: boolean;
}

export interface TelegramFile {
  file_path?: string;
  file_size?: number;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<TelegramResult<{ message_id: number }>>;
  editMessageText(chatId: number, messageId: number, text: string, options?: SendOptions): Promise<TelegramResult<unknown>>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResult<unknown>>;
  getFile(fileId: string): Promise<TelegramResult<TelegramFile>>;
  download(filePath: string): Promise<TelegramResult<Uint8Array>>;
  setWebhook(url: string): Promise<TelegramResult<unknown>>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<TelegramResult<unknown>>;
  /** Who the token belongs to: the setup script checks it against TELEGRAM_BOT_USERNAME. */
  getMe(): Promise<TelegramResult<{ id: number; username?: string }>>;
}

const API = "https://api.telegram.org";
/** A call that takes longer is given up: a cycle's stage and a webhook both have other work waiting. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

export function telegramClient(settings: TelegramSettings, fetchImpl: typeof fetch = fetch): TelegramClient {
  const scrub = (text: string) => text.split(settings.token).join("<token>");
  const failure = (error: unknown) => ({ ok: false as const, status: 0, description: scrub(error instanceof Error ? error.message : "network error") });

  async function call<T>(method: string, body: Record<string, unknown>): Promise<TelegramResult<T>> {
    try {
      const response = await fetchImpl(`${API}/bot${settings.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
      if (response.ok && payload?.ok === true) return { ok: true, result: payload.result as T };
      return { ok: false, status: response.status, description: scrub(payload?.description ?? `status ${response.status}`) };
    } catch (error) {
      return failure(error);
    }
  }

  const text = (value: string, options?: SendOptions) =>
    options?.plain ? { text: value } : { text: value, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  const markup = (options?: SendOptions) => (options?.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {});

  return {
    sendMessage: (chatId, value, options) => call("sendMessage", { chat_id: chatId, ...text(value, options), ...markup(options) }),
    editMessageText: (chatId, messageId, value, options) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, ...text(value, options), ...markup(options) }),
    answerCallbackQuery: (callbackQueryId, value) =>
      call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(value ? { text: value } : {}) }),
    getFile: (fileId) => call("getFile", { file_id: fileId }),
    async download(filePath) {
      try {
        const response = await fetchImpl(`${API}/file/bot${settings.token}/${filePath}`, { signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) });
        if (!response.ok) return { ok: false, status: response.status, description: `status ${response.status}` };
        return { ok: true, result: new Uint8Array(await response.arrayBuffer()) };
      } catch (error) {
        return failure(error);
      }
    },
    setWebhook: (url) =>
      call("setWebhook", { url, secret_token: settings.webhookSecret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
    setMyCommands: (commands) => call("setMyCommands", { commands }),
    getMe: () => call("getMe", {}),
  };
}
