import { describe, expect, it } from "vitest";
import { takeTelegramChatToken } from "@/lib/rate-limit";
import { telegramClient } from "@/lib/telegram/client";
import { telegramLink, telegramSettingsFromEnv } from "@/lib/telegram/settings";

/**
 * The Telegram settings and the Bot API client (Telegram bot design R1, §6): the feature is off unless all three
 * variables are set and well formed; every call answers ok or a status, never throws, and never repeats the token.
 */

const TOKEN = "123456:AAH-secret-bot-token";
const SECRET = "s3cret_webhook-value-0123";
const SETTINGS = { token: TOKEN, webhookSecret: SECRET, username: "vestiarion_bot" };

interface Sent {
  url: string;
  body: Record<string, unknown> | undefined;
}

function recorder(reply: (url: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return reply(url);
  };
  return { sent, client: telegramClient(SETTINGS, fetchImpl) };
}

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });

describe("telegramSettingsFromEnv", () => {
  const full = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "@vestiarion_bot" };

  it("reads all three, the username without its @", () => {
    expect(telegramSettingsFromEnv(full)).toEqual(SETTINGS);
  });

  it.each(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME"])("is off without %s", (name) => {
    expect(telegramSettingsFromEnv({ ...full, [name]: "" })).toBeNull();
  });

  it.each([
    ["shorter than 16 characters", "short-secret"],
    ["holding a character Telegram refuses", "secret with spaces in it"],
  ])("is off with a webhook secret %s", (_label, secret) => {
    expect(telegramSettingsFromEnv({ ...full, TELEGRAM_WEBHOOK_SECRET: secret })).toBeNull();
  });

  it("links a code to the bot's start command", () => {
    expect(telegramLink(SETTINGS, "Abc_123-xyz")).toBe("https://t.me/vestiarion_bot?start=Abc_123-xyz");
  });
});

describe("telegramClient", () => {
  it("sends HTML with link previews off, and the keyboard as an inline keyboard", async () => {
    const { sent, client } = recorder(() => ok({ message_id: 7 }));
    const result = await client.sendMessage(42, "<b>Paid</b>", { keyboard: [[{ text: "Open", url: "https://www.vestiarion.xyz/o/acme/console" }]] });

    expect(result).toEqual({ ok: true, result: { message_id: 7 } });
    expect(sent).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        body: {
          chat_id: 42,
          text: "<b>Paid</b>",
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [[{ text: "Open", url: "https://www.vestiarion.xyz/o/acme/console" }]] },
        },
      },
    ]);
  });

  it("sends plain text with no formatting when asked", async () => {
    const { sent, client } = recorder(() => ok({ message_id: 8 }));
    await client.sendMessage(42, "Paid A&B <Ltd>", { plain: true });
    expect(sent[0].body).toEqual({ chat_id: 42, text: "Paid A&B <Ltd>" });
  });

  it("answers a refusal with Telegram's status and description", async () => {
    const { client } = recorder(
      () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 })
    );
    expect(await client.sendMessage(42, "hi")).toEqual({ ok: false, status: 403, description: "Forbidden: bot was blocked by the user" });
  });

  it("answers a network failure with status 0, without the token in the description", async () => {
    const { client } = recorder((url) => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    const result = await client.sendMessage(42, "hi");
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("downloads a file from the file endpoint", async () => {
    const { sent, client } = recorder(() => new Response(new Uint8Array([37, 80, 68, 70])));
    const result = await client.download("documents/file_3.pdf");
    expect(sent[0].url).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/file_3.pdf`);
    expect(result).toEqual({ ok: true, result: new Uint8Array([37, 80, 68, 70]) });
  });

  it("registers the webhook with the secret, for messages and button presses only, dropping what queued before", async () => {
    const { sent, client } = recorder(() => ok(true));
    await client.setWebhook("https://www.vestiarion.xyz/api/telegram");
    expect(sent[0].body).toEqual({
      url: "https://www.vestiarion.xyz/api/telegram",
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
  });
});

describe("takeTelegramChatToken", () => {
  it("lets a chat send 20 messages, then one more every 3 seconds", () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) expect(takeTelegramChatToken("chat-a", now)).toBe(true);
    expect(takeTelegramChatToken("chat-a", now)).toBe(false);
    expect(takeTelegramChatToken("chat-b", now)).toBe(true);
    expect(takeTelegramChatToken("chat-a", now + 3_000)).toBe(true);
    expect(takeTelegramChatToken("chat-a", now + 3_000)).toBe(false);
  });
});
