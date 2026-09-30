import { db, unwrap, type OrgDb } from "../dal";
import { chainModes, getChainProvider, type ChainProvider } from "../circle";
import { CIRCLE_UNREACHABLE } from "../copy";

export { CIRCLE_UNREACHABLE };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/**
 * The operating account in live mode while the USYC leg is simulated: the
 * reserve is a notional carve-out of the USDC in the operating wallet, so
 * `spendable + reserve` is what is on chain. The carve-out is clamped to that
 * amount: a reserve larger than the money that exists (a simulated one
 * carried over, or funds moved out of the wallet) never claims more than is
 * there.
 */
export function liveOperatingBalance(onChain: number, notionalReserve: number): { spendable: number; reserve: number } {
  const available = Math.max(0, onChain);
  const reserve = Math.min(Math.max(0, notionalReserve), available);
  return { spendable: Number((available - reserve).toFixed(6)), reserve };
}

export interface BalanceChange {
  accountId: string;
  name: string;
  from: number;
  to: number;
  /** The carve-out, in words, when one was taken: "on-chain 150 less 30 notional reserve". */
  note: string | null;
}

export interface BalanceFailure {
  accountId: string;
  name: string;
  /** The error as thrown. For the cycle's own ledger lines only: never shown to a person or returned by an action. */
  message: string;
}

/** One account's read, in the order the accounts were read. */
export type BalanceOutcome =
  | ({ kind: "changed" } & BalanceChange)
  | { kind: "unchanged"; accountId: string; name: string; balance: number }
  | ({ kind: "failed" } & BalanceFailure);

export interface BalanceSync {
  changes: BalanceChange[];
  failures: BalanceFailure[];
  /** Every account read, changes and failures interleaved as they happened — what the cycle's lines follow. */
  outcomes: BalanceOutcome[];
  /** When this read ran: what `balance_synced_at` was set to on every account read without a failure. */
  syncedAt: string;
}

/**
 * Reads each non-reserve account's USDC from the chain and writes the stored
 * balance back from it — the reconcile stage's read, shared with the console's
 * balance refresh.
 *
 * In live mode the chain is the source of truth for cash. Reading the stored
 * balance instead would let the agent authorise payments against money that
 * is no longer there — the exact failure a treasury agent must not have.
 *
 * While the USYC leg is simulated, the reserve is a *notional* carve-out:
 * those USDC physically remain in the operating wallet. Subtracting it keeps
 * the identity `operating + reserve == on-chain total`, so the reserve cannot
 * conjure a balance that does not exist on Arc.
 *
 * `balance_synced_at` is written on every account read, whether or not the
 * balance changed; `balance` only when it did. An account whose read or write
 * fails is recorded and the next one is read regardless.
 *
 * By default every non-reserve account is asked about, as the reconcile stage
 * always has: an account with no wallet is then a failure the cycle's log
 * names. `walletsOnly` skips those instead, for a caller that only wants the
 * money there is.
 *
 * The caller decides whether the provider is live; this reads whatever it is given.
 */
export async function syncOnChainBalances(
  provider: ChainProvider,
  orgDb: OrgDb,
  options: { walletsOnly?: boolean } = {}
): Promise<BalanceSync> {
  const rows = unwrap(
    await orgDb.from("accounts").select("id, name, kind, balance, circle_wallet_id")
  ) as Array<{ id: string; name: string; kind: string; balance: string; circle_wallet_id: string | null }>;
  const syncedAt = new Date().toISOString();

  const notionalReserve =
    provider.earnMode === "simulate"
      ? num(rows.find((a) => a.kind === "reserve")?.balance)
      : 0;

  const outcomes: BalanceOutcome[] = [];
  const accounts = rows.filter((a) => a.kind !== "reserve" && (!options.walletsOnly || !!a.circle_wallet_id));
  for (const account of accounts) {
    try {
      const snapshot = await provider.getBalance(account.id);
      const { spendable, reserve: carveOut } = liveOperatingBalance(
        snapshot.balance,
        account.kind === "operating" ? notionalReserve : 0
      );
      const stored = num(account.balance);
      const changed = Math.abs(spendable - stored) >= 0.000001;

      const res = await orgDb
        .from("accounts")
        .update(changed ? { balance: spendable, balance_synced_at: syncedAt } : { balance_synced_at: syncedAt })
        .eq("id", account.id);
      if (res.error) throw new Error(res.error.message);

      if (!changed) {
        outcomes.push({ kind: "unchanged", accountId: account.id, name: account.name, balance: stored });
        continue;
      }
      outcomes.push({
        kind: "changed",
        accountId: account.id,
        name: account.name,
        from: stored,
        to: spendable,
        note: carveOut > 0 ? `on-chain ${snapshot.balance} less ${carveOut} notional reserve` : null,
      });
    } catch (err) {
      outcomes.push({ kind: "failed", accountId: account.id, name: account.name, message: (err as Error).message });
    }
  }

  return {
    changes: outcomes.flatMap(({ kind, ...change }) => (kind === "changed" ? [change as BalanceChange] : [])),
    failures: outcomes.flatMap(({ kind, ...failure }) => (kind === "failed" ? [failure as BalanceFailure] : [])),
    outcomes,
    syncedAt,
  };
}

/** How long after a read the console's refresh answers from the database instead of asking Circle again. */
export const BALANCE_REFRESH_COOLDOWN_MS = 30_000;

export interface BalanceRefresh {
  /** Whether Circle was read, and every read succeeded. */
  refreshed: boolean;
  /** Why Circle was not read, or `unavailable` when it was and did not answer. Absent when `refreshed`. */
  reason?: "not_live" | "no_wallet" | "cooldown" | "unavailable";
  /** Present with `unavailable` only, and always the same fixed sentence. */
  message?: string;
  /** What the non-reserve accounts hold, as stored after this call. */
  balance: number;
  /** When the operating account's balance was last read from the chain, if ever. */
  syncedAt: string | null;
}

/**
 * The console's balance refresh: the reconcile stage's read, outside a cycle,
 * in the organization's scope already entered.
 *
 * Circle is asked only when payments are live, the operating account holds a
 * wallet, and its last read is at least 30 seconds old; otherwise this answers
 * from the stored figures. Every Circle request runs under the provider's own
 * deadline. A read that fails answers with a fixed sentence, and nothing of
 * Circle's error is logged or returned.
 */
export async function refreshOnChainBalances(options: { now?: number } = {}): Promise<BalanceRefresh> {
  const orgDb = db();
  const rows = unwrap(
    await orgDb.from("accounts").select("id, kind, balance, circle_wallet_id, balance_synced_at")
  ) as Array<{ id: string; kind: string; balance: string; circle_wallet_id: string | null; balance_synced_at: string | null }>;

  const total = (written: ReadonlyMap<string, number> = new Map()) =>
    Number(
      rows
        .filter((a) => a.kind !== "reserve")
        .reduce((sum, a) => sum + (written.get(a.id) ?? num(a.balance)), 0)
        .toFixed(6)
    );
  const operating = rows.find((a) => a.kind === "operating" && !!a.circle_wallet_id);
  const storedSyncedAt = operating?.balance_synced_at ?? null;

  if (chainModes().mode !== "live") return { refreshed: false, reason: "not_live", balance: total(), syncedAt: storedSyncedAt };
  if (!operating) return { refreshed: false, reason: "no_wallet", balance: total(), syncedAt: null };

  const now = options.now ?? Date.now();
  if (storedSyncedAt) {
    const elapsed = now - Date.parse(storedSyncedAt);
    if (elapsed >= 0 && elapsed < BALANCE_REFRESH_COOLDOWN_MS) {
      return { refreshed: false, reason: "cooldown", balance: total(), syncedAt: storedSyncedAt };
    }
  }

  let sync: BalanceSync;
  try {
    sync = await syncOnChainBalances(getChainProvider(), orgDb, { walletsOnly: true });
  } catch {
    console.error("refreshOnChainBalances: the balance read did not complete");
    return { refreshed: false, reason: "unavailable", message: CIRCLE_UNREACHABLE, balance: total(), syncedAt: storedSyncedAt };
  }

  const balance = total(new Map(sync.changes.map((change) => [change.accountId, change.to])));
  if (sync.failures.length > 0) {
    console.error(`refreshOnChainBalances: ${sync.failures.length} of ${sync.outcomes.length} balance reads did not complete`);
    const operatingRead = !sync.failures.some((failure) => failure.accountId === operating.id);
    return {
      refreshed: false,
      reason: "unavailable",
      message: CIRCLE_UNREACHABLE,
      balance,
      syncedAt: operatingRead ? sync.syncedAt : storedSyncedAt,
    };
  }
  return { refreshed: true, balance, syncedAt: sync.syncedAt };
}
