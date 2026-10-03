/**
 * The platform's one Telegram bot (Telegram bot design R1). The feature is off unless all three variables are set:
 * the bot's token from @BotFather, the secret Telegram sends back on every webhook call, and the bot's username, for
 * the links that open it.
 */
export interface TelegramSettings {
  token: string;
  webhookSecret: string;
  /** Without the leading `@`. */
  username: string;
}

/** Telegram's own rule for `secret_token` (1–256 of A–Z, a–z, 0–9, _ and -), with a floor of 16 characters. */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{16,256}$/;
/** Telegram's rule for a bot's username. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

export function telegramSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramSettings | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (!token || !webhookSecret || !username) return null;
  // Never the values themselves: only that they were not used.
  if (!WEBHOOK_SECRET.test(webhookSecret)) {
    console.warn("Telegram is off: TELEGRAM_WEBHOOK_SECRET must be 16 to 256 letters, digits, _ or -");
    return null;
  }
  if (!BOT_USERNAME.test(username)) {
    console.warn("Telegram is off: TELEGRAM_BOT_USERNAME is not a bot username");
    return null;
  }
  return { token, webhookSecret, username };
}

/** The link that opens the bot and sends it `/start <code>` (R4). */
export function telegramLink(settings: TelegramSettings, code: string): string {
  return `https://t.me/${settings.username}?start=${code}`;
}
