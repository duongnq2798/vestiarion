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

/**
 * One account's read, in the order the accounts were read. `superseded` is the
 * compare-and-set's only: the balance, or the reserve carved out of it, had
 * changed since it was read, so the value a concurrent writer left stands.
 */
export type BalanceOutcome =
  | ({ kind: "changed" } & BalanceChange)
  | { kind: "unchanged"; accountId: string; name: string; balance: number }
  | { kind: "superseded"; accountId: string; name: string }
  | ({ kind: "failed" } & BalanceFailure);

export interface BalanceSync {
  changes: BalanceChange[];
  failures: BalanceFailure[];
  /** Every account read, changes and failures interleaved as they happened — what the cycle's lines follow. */
  outcomes: BalanceOutcome[];
  /** When this read ran: what `balance_synced_at` is set to, best effort, on every account that changed or was unchanged. */
  syncedAt: string;
}

export interface SyncOptions {
  /** Skip non-reserve accounts that hold no wallet, instead of recording each as a failure. */
  walletsOnly?: boolean;
  /**
   * Write a changed balance only while the row still holds the value that was
   * read, and only while the reserve carved out of it is unchanged: for a
   * caller that may run beside a cycle. The cycle itself does not ask for it.
   */
  compareAndSet?: boolean;
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
 * Without options, this writes exactly what the reconcile stage always wrote:
 * `{ balance }` for each balance that changed, and an account whose read or
 * write fails is recorded as a failure while the next one is read regardless.
 * After the balances, `balance_synced_at` is recorded in one separate write,
 * best effort: it never throws and never becomes a failure, so a database
 * without the column (before migration 0032) reconciles exactly as before.
 *
 * By default every non-reserve account is asked about, as the reconcile stage
 * always has: an account with no wallet is then a failure the cycle's log
 * names. The caller decides whether the provider is live; this reads whatever
 * it is given.
 */
export async function syncOnChainBalances(provider: ChainProvider, orgDb: OrgDb, options: SyncOptions = {}): Promise<BalanceSync> {
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
      const carvesReserve = account.kind === "operating";
      const { spendable, reserve: carveOut } = liveOperatingBalance(snapshot.balance, carvesReserve ? notionalReserve : 0);
      const stored = num(account.balance);
      if (Math.abs(spendable - stored) < 0.000001) {
        outcomes.push({ kind: "unchanged", accountId: account.id, name: account.name, balance: stored });
        continue;
      }

      if (options.compareAndSet) {
        if (carvesReserve && provider.earnMode === "simulate" && !(await reserveStill(orgDb, notionalReserve))) {
          outcomes.push({ kind: "superseded", accountId: account.id, name: account.name });
          continue;
        }
        const res = await orgDb
          .from("accounts")
          .update({ balance: spendable })
          .eq("id", account.id)
          .eq("balance", account.balance)
          .select("id");
        if (res.error) throw new Error(res.error.message);
        if (!res.data || res.data.length === 0) {
          outcomes.push({ kind: "superseded", accountId: account.id, name: account.name });
          continue;
        }
      } else {
        const res = await orgDb
          .from("accounts")
          .update({ balance: spendable })
          .eq("id", account.id);
        if (res.error) throw new Error(res.error.message);
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

  await recordSyncedAt(
    orgDb,
    outcomes.filter((o) => o.kind === "changed" || o.kind === "unchanged").map((o) => o.accountId),
    syncedAt
  );

  return {
    changes: outcomes.flatMap(({ kind, ...change }) => (kind === "changed" ? [change as BalanceChange] : [])),
    failures: outcomes.flatMap(({ kind, ...failure }) => (kind === "failed" ? [failure as BalanceFailure] : [])),
    outcomes,
    syncedAt,
  };
}

/** Whether the reserve still holds what was carved out of the operating balance. */
async function reserveStill(orgDb: OrgDb, carved: number): Promise<boolean> {
  const rows = unwrap(await orgDb.from("accounts").select("balance").eq("kind", "reserve")) as Array<{ balance: string }>;
  return Math.abs(num(rows[0]?.balance) - carved) < 0.000001;
}

/** Best effort, and silent but for a fixed log line: see `syncOnChainBalances`. */
async function recordSyncedAt(orgDb: OrgDb, accountIds: string[], syncedAt: string): Promise<void> {
  if (accountIds.length === 0) return;
  try {
    const res = await orgDb.from("accounts").update({ balance_synced_at: syncedAt }).in("id", accountIds);
    if (res.error) throw new Error("not recorded");
  } catch {
    console.error("syncOnChainBalances: balance_synced_at not recorded");
  }
}

/** How long after a read, or a claim to read, the console's refresh answers from the database instead of asking Circle. */
export const BALANCE_REFRESH_COOLDOWN_MS = 30_000;

/** A cycle row still `running` that started this recently is in progress: the window `delete_org` (0031) uses. */
export const CYCLE_IN_PROGRESS_MS = 15 * 60_000;

export interface BalanceRefresh {
  /** Whether Circle was read, and every read succeeded. */
  refreshed: boolean;
  /** Why Circle was not read, or `unavailable` when it was and did not answer. Absent when `refreshed`. */
  reason?: "not_live" | "no_wallet" | "cooldown" | "cycle_running" | "unavailable";
  /** Present with `unavailable` only, and always the same fixed sentence. */
  message?: string;
  /** What the non-reserve accounts hold, as stored after this call. */
  balance: number;
  /** When the operating account's balance was last read from the chain, if ever. */
  syncedAt: string | null;
  /** With `refreshed`: whether the non-reserve total is higher than it was before the read (funds arrived). */
  rose?: boolean;
}

type StoredAccount = { id: string; kind: string; balance: string; circle_wallet_id: string | null; balance_synced_at: string | null };

async function storedAccounts(orgDb: OrgDb): Promise<StoredAccount[]> {
  return unwrap(await orgDb.from("accounts").select("id, kind, balance, circle_wallet_id, balance_synced_at")) as StoredAccount[];
}

const nonReserveTotal = (rows: StoredAccount[]) =>
  Number(rows.filter((a) => a.kind !== "reserve").reduce((sum, a) => sum + num(a.balance), 0).toFixed(6));

/**
 * The console's balance refresh: the reconcile stage's read, outside a cycle,
 * in the organization's scope already entered, made safe to run beside one.
 *
 * Circle is asked only when payments are live, the operating account holds a
 * wallet, its last read is at least 30 seconds old, no cycle is running (a
 * `running` row younger than 15 minutes), and this request wins the claim on
 * the operating account — an update of `balance_refresh_claimed_at` that
 * matches only while no claim is younger than 30 seconds, so a failed read
 * backs off as a good one does, and two tabs make one call. Everything else
 * answers from the stored figures.
 *
 * The balance writes are compare-and-set on what was read (see
 * `syncOnChainBalances`), so a cycle that wrote meanwhile is never undone; the
 * answer is read back from the database afterwards, whoever wrote it. Every
 * Circle request runs under the provider's own deadline. A read that fails
 * answers with a fixed sentence, and nothing of Circle's error is logged or
 * returned.
 */
export async function refreshOnChainBalances(options: { now?: number } = {}): Promise<BalanceRefresh> {
  const orgDb = db();
  const rows = await storedAccounts(orgDb);
  const operating = rows.find((a) => a.kind === "operating" && !!a.circle_wallet_id);
  const storedSyncedAt = operating?.balance_synced_at ?? null;
  const stored = (reason: NonNullable<BalanceRefresh["reason"]>): BalanceRefresh => ({
    refreshed: false,
    reason,
    balance: nonReserveTotal(rows),
    syncedAt: storedSyncedAt,
  });

  if (chainModes().mode !== "live") return stored("not_live");
  if (!operating) return stored("no_wallet");

  const now = options.now ?? Date.now();
  if (storedSyncedAt) {
    const elapsed = now - Date.parse(storedSyncedAt);
    if (elapsed >= 0 && elapsed < BALANCE_REFRESH_COOLDOWN_MS) return stored("cooldown");
  }

  const running = unwrap(
    await orgDb
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(now - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) return stored("cycle_running");

  const claim = await orgDb
    .from("accounts")
    .update({ balance_refresh_claimed_at: new Date(now).toISOString() })
    .eq("id", operating.id)
    .or(`balance_refresh_claimed_at.is.null,balance_refresh_claimed_at.lt.${new Date(now - BALANCE_REFRESH_COOLDOWN_MS).toISOString()}`)
    .select("id");
  if (claim.error) throw new Error(claim.error.message);
  if (!claim.data || claim.data.length === 0) return stored("cooldown");

  let sync: BalanceSync;
  try {
    sync = await syncOnChainBalances(getChainProvider(), orgDb, { walletsOnly: true, compareAndSet: true });
  } catch {
    console.error("refreshOnChainBalances: the balance read did not complete");
    return { ...stored("unavailable"), message: CIRCLE_UNREACHABLE };
  }

  const after = await storedAccounts(orgDb);
  const balance = nonReserveTotal(after);
  const syncedAt = after.find((a) => a.id === operating.id)?.balance_synced_at ?? storedSyncedAt;
  if (sync.failures.length > 0) {
    console.error(`refreshOnChainBalances: ${sync.failures.length} of ${sync.outcomes.length} balance reads did not complete`);
    return { refreshed: false, reason: "unavailable", message: CIRCLE_UNREACHABLE, balance, syncedAt };
  }
  return { refreshed: true, balance, syncedAt, rose: balance > nonReserveTotal(rows) };
}
