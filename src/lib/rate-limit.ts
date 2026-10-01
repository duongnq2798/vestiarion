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

const payCheckBuckets = new Map<string, Bucket>();

/**
 * "I have paid" on a pay link reads Circle (receivables on Arc R5): three checks, then one every 20 s,
 * per receivable. Single-instance, like the others.
 */
export function takePayCheckToken(key: string, now = Date.now()): boolean {
  return take(payCheckBuckets, key, 3, 20_000, now);
}
