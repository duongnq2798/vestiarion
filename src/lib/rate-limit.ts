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

const fxWatchBuckets = new Map<string, Bucket>();

/**
 * Two FX watches a minute per client (FX re-evaluation F4), in their own bucket so a watch never takes the tick's
 * token. Single-instance, like the cycle guard.
 */
export function takeFxWatchToken(key: string, now = Date.now()): boolean {
  return take(fxWatchBuckets, key, 2, 60_000, now);
}

const transferWatchBuckets = new Map<string, Bucket>();

/**
 * Two transfer watches a minute per client (stuck-transfer alert D3), in their own bucket so a watch never takes the
 * tick's or the FX watch's token. Single-instance, like the cycle guard.
 */
export function takeTransferWatchToken(key: string, now = Date.now()): boolean {
  return take(transferWatchBuckets, key, 2, 60_000, now);
}

const circleNotificationBuckets = new Map<string, Bucket>();

/**
 * Three hundred Circle notifications a minute per client (Circle notifications N2): Circle sends one per state change of
 * every transfer, so the allowance is wide; it bounds what an unsigned flood can make the route read. Single-instance.
 */
export function takeCircleNotificationToken(key: string, now = Date.now()): boolean {
  return take(circleNotificationBuckets, key, 300, 60_000, now);
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
 * A burst of 30 writes per API key, then one every 2 seconds (write API R6), so up to about 60 in a key's first minute:
 * a key that adds records in a loop is slowed down before it fills the workspace. Keyed by the key's id, never by IP, so
 * one caller's writes never spend another's. Single-instance, like the others.
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

const portalActionBuckets = new Map<string, Bucket>();

/**
 * What a customer's statement link sends (customer portal P6): five requests or messages at once, then one every 12 s,
 * per link. Single-instance, like the others; the database's cap of 30 a day per link (0109) holds across instances.
 */
export function takePortalActionToken(key: string, now = Date.now()): boolean {
  return take(portalActionBuckets, key, 5, 12_000, now);
}

const payeeInvoiceBuckets = new Map<string, Bucket>();

/**
 * What a payee link's invoice step sends (payee invoice link P6): three tries at once, then one every 20 s, per link,
 * so a page cannot make the document reader read without end. Single-instance, like the others; the database takes
 * one invoice per link (0133) across instances.
 */
export function takePayeeInvoiceToken(key: string, now = Date.now()): boolean {
  return take(payeeInvoiceBuckets, key, 3, 20_000, now);
}

const extensionTokenBuckets = new Map<string, Bucket>();

/**
 * Ten token or revoke requests a minute per address (invoice capture design C18): a code or a refresh token is tried
 * at no faster pace. Single-instance, like the others.
 */
export function takeExtensionTokenRequest(key: string, now = Date.now()): boolean {
  return take(extensionTokenBuckets, key, 10, 6_000, now);
}

const extensionApiBuckets = new Map<string, Bucket>();

/**
 * Sixty draft requests a minute per Chrome extension connection (invoice capture design C18), keyed by the connection,
 * never by address. The reader's own five reads a minute per workspace still apply to a capture. Single-instance.
 */
export function takeExtensionApiToken(connectionId: string, now = Date.now()): boolean {
  return take(extensionApiBuckets, connectionId, 60, 1_000, now);
}

const extensionConsentBuckets = new Map<string, Bucket>();

/** Ten consents a minute per person (invoice capture design C18): each issues a one-time code. Single-instance. */
export function takeExtensionConsentToken(userId: string, now = Date.now()): boolean {
  return take(extensionConsentBuckets, userId, 10, 6_000, now);
}
