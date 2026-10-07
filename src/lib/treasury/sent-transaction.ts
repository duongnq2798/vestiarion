/**
 * A transaction the owner's wallet sent for a setup step (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md
 * W8, W9), kept in the browser until the server records it. A page reloaded or closed before the chain showed it asks
 * again for the same transaction, so the owner is not asked to deploy a second contract. Only the hash is kept, which the
 * chain makes public anyway. It runs in the browser and holds no secret.
 */

export type SentStep = "deploy" | "approve";

/** The parts of `localStorage` used, so a test can stand in for it; null where the browser has none. */
export type SentStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** What a recording action answers (`RecordActionResult`). */
export interface RecordAnswer {
  ok: boolean;
  message: string;
  state: "pending" | "verified" | null;
  chainUnreadable?: true;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const key = (orgSlug: string, step: SentStep) => `vestiarion.wallet-treasury.${orgSlug}.${step}`;

/** Keeps the hash the wallet answered with; a browser that refuses storage keeps nothing, and the page still waits. */
export function rememberSent(store: SentStore | null, orgSlug: string, step: SentStep, hash: string): void {
  try {
    store?.setItem(key(orgSlug, step), hash);
  } catch {
    // A private window or full storage: only a reload loses it.
  }
}

/** The hash kept for this step, if it is one. */
export function sentHash(store: SentStore | null, orgSlug: string, step: SentStep): string | null {
  try {
    const value = store?.getItem(key(orgSlug, step)) ?? null;
    return value !== null && HASH.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function forgetSent(store: SentStore | null, orgSlug: string, step: SentStep): void {
  try {
    store?.removeItem(key(orgSlug, step));
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}

/**
 * Asks the server to record `hash` until the chain shows it: "verified" once it is recorded, and forgotten then;
 * "pending" when the chain has not shown it after `tries`, kept to ask again. A moment the chain cannot be read is
 * waited out like a pending answer, and said if it lasts to the last try. Any other refusal is final: it is said in its
 * own words, and the transaction forgotten.
 */
export async function recordSent(input: {
  store: SentStore | null;
  orgSlug: string;
  step: SentStep;
  hash: string;
  record: (hash: string) => Promise<RecordAnswer>;
  tries: number;
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"verified" | "pending"> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let unreadable: string | null = null;
  for (let attempt = 0; attempt < input.tries; attempt += 1) {
    if (attempt > 0) await sleep(input.waitMs);
    const answer = await input.record(input.hash);
    if (answer.ok && answer.state === "verified") {
      forgetSent(input.store, input.orgSlug, input.step);
      return "verified";
    }
    if (!answer.ok && !answer.chainUnreadable) {
      forgetSent(input.store, input.orgSlug, input.step);
      throw new Error(answer.message);
    }
    unreadable = answer.ok ? null : answer.message;
  }
  if (unreadable) throw new Error(unreadable);
  return "pending";
}
