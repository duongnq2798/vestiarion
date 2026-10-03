import type { TelegramClient, TelegramResult } from "@/lib/telegram/client";

/** One Bot API call a fake client received: the method's name and its arguments. */
export interface TelegramCall {
  method: keyof TelegramClient;
  args: unknown[];
}

/**
 * A Telegram client that records every call and answers each as `answer` says (ok, with message id 99, by default),
 * for tests of what the bot sends without a network.
 */
export function fakeTelegram(answer: (call: TelegramCall) => TelegramResult<unknown> = () => ({ ok: true, result: { message_id: 99 } })) {
  const calls: TelegramCall[] = [];
  const record =
    (method: keyof TelegramClient) =>
    async (...args: unknown[]) => {
      const call = { method, args };
      calls.push(call);
      return answer(call);
    };
  const client = {
    sendMessage: record("sendMessage"),
    editMessageText: record("editMessageText"),
    answerCallbackQuery: record("answerCallbackQuery"),
    getFile: record("getFile"),
    download: record("download"),
    setWebhook: record("setWebhook"),
    setMyCommands: record("setMyCommands"),
    getMe: record("getMe"),
  } as unknown as TelegramClient;
  return {
    client,
    calls,
    /** The text of every message sent or edited, in order. */
    texts: () => calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText").map((call) => String(call.args[call.method === "sendMessage" ? 1 : 2])),
  };
}
