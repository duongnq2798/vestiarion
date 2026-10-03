/**
 * Registers the Telegram bot's webhook and its command menu (docs/superpowers/specs/2026-10-03-telegram-bot-design.md,
 * R1). Run once per deployment, after TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_BOT_USERNAME are set
 * there and here:
 *
 *   npm run telegram:setup -- https://www.vestiarion.xyz
 *
 * The origin defaults to SITE_URL. Telegram only calls an https webhook. The token and the secret are never printed.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { telegramSettingsFromEnv } = await import("../src/lib/telegram/settings");
  const { telegramClient } = await import("../src/lib/telegram/client");
  const { BOT_COMMANDS } = await import("../src/lib/telegram/messages");

  const settings = telegramSettingsFromEnv();
  if (!settings) {
    throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (16 to 256 of A-Z a-z 0-9 _ -) and TELEGRAM_BOT_USERNAME first.");
  }
  const raw = process.argv[2] ?? process.env.SITE_URL;
  if (!raw) throw new Error("Pass the deployment's origin: npm run telegram:setup -- https://www.vestiarion.xyz");
  const origin = new URL(raw).origin;
  if (!origin.startsWith("https://")) throw new Error(`Telegram only calls an https webhook, and ${origin} is not one.`);

  const client = telegramClient(settings);
  const me = await client.getMe();
  if (!me.ok) throw new Error(`Telegram refused the token: ${me.description}`);
  if (me.result.username?.toLowerCase() !== settings.username.toLowerCase()) {
    throw new Error(`TELEGRAM_BOT_USERNAME is ${settings.username}, but the token belongs to @${me.result.username ?? "a bot with no username"}.`);
  }
  const url = `${origin}/api/telegram`;
  const webhook = await client.setWebhook(url);
  if (!webhook.ok) throw new Error(`Telegram did not set the webhook: ${webhook.description}`);
  const commands = await client.setMyCommands([...BOT_COMMANDS]);
  if (!commands.ok) throw new Error(`Telegram did not set the command menu: ${commands.description}`);

  console.log(`Webhook set to ${url} for @${me.result.username}, with ${BOT_COMMANDS.length} commands in its menu.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
