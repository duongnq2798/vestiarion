interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
const CAPACITY = 2;
const REFILL_INTERVAL_MS = 60_000;

/**
 * Small single-instance guard for the expensive cycle endpoint. It is not a
 * distributed quota: multi-instance deployments should replace it with a
 * shared store while retaining the bearer check.
 */
export function takeAgentCycleToken(key: string, now = Date.now()): boolean {
  const current = buckets.get(key) ?? { tokens: CAPACITY, updatedAt: now };
  const elapsed = Math.max(0, now - current.updatedAt);
  const refilled = Math.min(CAPACITY, current.tokens + elapsed / REFILL_INTERVAL_MS);

  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, updatedAt: now });
    return false;
  }

  buckets.set(key, { tokens: refilled - 1, updatedAt: now });
  return true;
}
