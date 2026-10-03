interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** A token bucket per key: `capacity` tokens, refilled one every `refillMs`. */
function take(buckets: Map<string, Bucket>, key: string, capacity: number, refillMs: number, now: number): boolean {
  const current = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const elapsed = Math.max(0, now - current.updatedAt);
  const refilled = Math.min(capacity, current.tokens + elapsed / refillMs);

  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, updatedAt: now });
    return false;
  }

  buckets.set(key, { tokens: refilled - 1, updatedAt: now });
  return true;
}

const cycleBuckets = new Map<string, Bucket>();

/**
 * Small single-instance guard for the expensive cycle endpoint. It is not a
 * distributed quota: multi-instance deployments should replace it with a
 * shared store while retaining the bearer check.
 */
export function takeAgentCycleToken(key: string, now = Date.now()): boolean {
  return take(cycleBuckets, key, 2, 60_000, now);
}

const documentBuckets = new Map<string, Bucket>();

/**
 * Five invoice documents a minute per workspace, each read by the model
 * (invoice from a document D9). Single-instance, like the cycle guard.
 */
export function takeDocumentReadToken(key: string, now = Date.now()): boolean {
  return take(documentBuckets, key, 5, 12_000, now);
}

const apiWriteBuckets = new Map<string, Bucket>();

/**
 * Thirty writes a minute per API key (write API R6): a key that adds records in a loop is slowed down before it fills
 * the workspace. Keyed by the key's id, never by IP, so one caller's writes never spend another's. Single-instance,
 * like the others.
 */
export function takeApiWriteToken(keyId: string, now = Date.now()): boolean {
  return take(apiWriteBuckets, keyId, 30, 2_000, now);
}

const telegramChatBuckets = new Map<string, Bucket>();

/**
 * Twenty messages a minute per Telegram chat (Telegram bot design §6): a chat's plain text can ask the model what it
 * means, so one chat must not run the model without end. Single-instance, like the others.
 */
export function takeTelegramChatToken(chatId: string, now = Date.now()): boolean {
  return take(telegramChatBuckets, chatId, 20, 3_000, now);
}

const payCheckBuckets = new Map<string, Bucket>();

/**
 * "I have paid" on a pay link reads Circle (receivables on Arc R5): three checks, then one every 20 s,
 * per receivable. Single-instance, like the others.
 */
export function takePayCheckToken(key: string, now = Date.now()): boolean {
  return take(payCheckBuckets, key, 3, 20_000, now);
}

const slackUserBuckets = new Map<string, Bucket>();

/**
 * Twenty commands and clicks a minute per Slack account (Slack design S6, S10), keyed by team and user: a click can
 * move money and a command reads the workspace, so one account cannot repeat either without end. Single-instance,
 * like the others.
 */
export function takeSlackUserToken(key: string, now = Date.now()): boolean {
  return take(slackUserBuckets, key, 20, 3_000, now);
}
