import type { Hex } from "viem";
import { PasskeyTreasuryError, pollRecord, type KeepingStore, type RecordAnswer } from "../passkey-treasury";
import type { SendOutcome } from "../passkey-wallet-send";
import type { WalletControlKind } from "./wallet-treasury";

/**
 * A control a treasury's own wallet sent from this browser (treasury wallet controls, review I1), kept until the server
 * records it: a page reloaded, or a confirmation slower than the page waits, asks about it again, so a stop still pauses
 * the agent and new figures still become its spending limit. Only the kind and the hash are kept, which the chain makes
 * public anyway. One per workspace: the panel sends nothing else while one is kept. Browser-safe.
 */

export interface PendingControl {
  kind: WalletControlKind;
  /** The transaction, once known; a passkey's user operation until then. */
  txHash?: Hex;
  userOpHash?: Hex;
}

const KINDS: readonly WalletControlKind[] = ["figures", "stop", "resume"];
const HASH = /^0x[0-9a-fA-F]{64}$/;
/** Said in the page when a control is kept or forgotten, so a panel reading the store reads it again. */
const CHANGED = "vestiarion:wallet-control";

const key = (orgSlug: string) => `vestiarion.wallet-treasury.${orgSlug}.control`;

function changed(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/** The control kept as stored, or null: a stable value a page can watch (`useSyncExternalStore`). */
export function storedControl(store: KeepingStore | null, orgSlug: string): string | null {
  try {
    return store?.getItem(key(orgSlug)) ?? null;
  } catch {
    return null;
  }
}

/** Reads a stored control back, if it is one this module could have kept. */
export function asPendingControl(stored: string | null): PendingControl | null {
  let value: unknown;
  try {
    value = stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, txHash, userOpHash } = value as { kind?: unknown; txHash?: unknown; userOpHash?: unknown };
  if (!KINDS.includes(kind as WalletControlKind)) return null;
  const tx = typeof txHash === "string" && HASH.test(txHash) ? (txHash as Hex) : undefined;
  const op = typeof userOpHash === "string" && HASH.test(userOpHash) ? (userOpHash as Hex) : undefined;
  if (!tx && !op) return null;
  return { kind: kind as WalletControlKind, ...(tx ? { txHash: tx } : {}), ...(op ? { userOpHash: op } : {}) };
}

export function pendingControl(store: KeepingStore | null, orgSlug: string): PendingControl | null {
  return asPendingControl(storedControl(store, orgSlug));
}

export function keepPendingControl(store: KeepingStore | null, orgSlug: string, pending: PendingControl): void {
  try {
    store?.setItem(key(orgSlug), JSON.stringify(pending));
  } catch {
    // A private window or full storage: only a reload loses it.
  }
  changed();
}

export function forgetPendingControl(store: KeepingStore | null, orgSlug: string): void {
  try {
    store?.removeItem(key(orgSlug));
  } catch {
    // Nothing to forget where nothing could be kept.
  }
  changed();
}

/** Calls `onChange` when a control is kept or forgotten here, or in another tab. */
export function subscribePendingControl(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Ends a control sent from this browser: kept before the server is asked, so a reload asks again; recorded once the
 * chain shows it, and forgotten then. A refusal is final: forgotten, and said in the server's words. A reverted one cost
 * only its fee. A passkey's user operation not yet in a transaction is kept to ask about later.
 */
export async function settleControl(input: {
  store: KeepingStore | null;
  orgSlug: string;
  kind: WalletControlKind;
  outcome: SendOutcome;
  record: (txHash: string) => Promise<RecordAnswer>;
  tries: number;
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
  label: string;
  say: (text: string) => void;
}): Promise<"verified" | "pending"> {
  const { store, orgSlug, kind, outcome, label } = input;
  const stillChecking = `Sent. ${label} has not confirmed it yet; reload this page in a minute to check it again. It is not sent twice.`;
  if (outcome.kind === "reverted") {
    forgetPendingControl(store, orgSlug);
    throw new PasskeyTreasuryError(`${label} did not carry it out; only its network fee was spent.`);
  }
  if (outcome.kind === "unconfirmed") {
    keepPendingControl(store, orgSlug, { kind, userOpHash: outcome.userOpHash as Hex });
    input.say(stillChecking);
    return "pending";
  }
  keepPendingControl(store, orgSlug, { kind, txHash: outcome.txHash as Hex });
  input.say(`Sent. Waiting for ${label} to confirm it…`);
  const polled = await pollRecord({ record: () => input.record(outcome.txHash), tries: input.tries, waitMs: input.waitMs, sleep: input.sleep });
  if (polled.state === "verified") {
    forgetPendingControl(store, orgSlug);
    return "verified";
  }
  if (polled.state === "refused") {
    forgetPendingControl(store, orgSlug);
    throw new PasskeyTreasuryError(polled.message);
  }
  input.say(stillChecking);
  return "pending";
}
