"use client";

import { RefreshCw } from "lucide-react";
import { startTransition, useActionState, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { RefreshBalanceResult } from "@/app/actions/treasury";
import { Button } from "@/components/ui/Button";
import { CIRCLE_UNREACHABLE, plural, utcMinute } from "@/lib/copy";
import { Money } from "./Primitives";
import { StatTile } from "./StatTile";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How fresh the balance is, in words. With no clock yet — the server render,
 * and the hydration that must match it — the time of the read itself, which
 * both sides compute the same.
 */
export function checkedLabel(syncedAt: string, now: number | null): string {
  if (now === null) return `Checked ${utcMinute(syncedAt)}`;
  const elapsed = now - Date.parse(syncedAt);
  if (elapsed < MINUTE) return "Checked just now";
  if (elapsed < HOUR) return `Checked ${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `Checked ${hours} ${plural(hours, "hour", "hours")} ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return `Checked ${days} ${plural(days, "day", "days")} ago`;
}

// A clock that ticks every 15 seconds, read through useSyncExternalStore: the
// server render has none (null), so it and the hydration agree, and the label
// turns relative once the page is live. Rounded, so every read within a tick
// returns the same value.
const TICK = 15_000;
function subscribeClock(onTick: () => void): () => void {
  const id = window.setInterval(onTick, TICK);
  return () => window.clearInterval(id);
}
const clockNow = () => Math.floor(Date.now() / TICK) * TICK;
const noClock = () => null;

/** The live tile's figure and its status line, from state alone: what the tests render. */
export function LiveBalanceView({
  label = "Balance on-chain",
  sub,
  balance,
  syncedAt,
  now,
  pending,
  failure,
  onRefresh,
}: {
  label?: string;
  sub?: ReactNode;
  balance: number;
  syncedAt: string | null;
  now: number | null;
  pending: boolean;
  /** The sentence to show when the last read failed; the balance shown is then the last known one. */
  failure: string | null;
  onRefresh: () => void;
}) {
  const age = syncedAt ? checkedLabel(syncedAt, now) : pending ? "Checking Circle…" : "Not checked yet";
  return (
    <StatTile
      label={label}
      sub={
        <>
          {sub && <span className="block">{sub}</span>}
          <span className="mt-1.5 flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1 text-xs text-ink-3">
              {/* The age ticks, so it stays out of the live region: only a refresh's result is announced. */}
              <span>{age}</span>
              <span aria-live="polite">{failure ? ` · ${failure}` : ""}</span>
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              icon={<RefreshCw aria-hidden />}
              loading={pending}
              onClick={onRefresh}
              aria-label="Refresh the on-chain balance"
              className="-my-1.5 -mr-1.5"
            />
          </span>
        </>
      }
    >
      <Money value={balance} />
    </StatTile>
  );
}

export interface TileState {
  /** The non-reserve accounts' total, as last known. */
  balance: number;
  syncedAt: string | null;
  failure: string | null;
}

/**
 * The tile's state after an answer. A failed read that still brought figures
 * back (some accounts read, or the stored ones) shows them, with the failure
 * beside their age; one that brought none keeps what the tile had.
 */
export function nextTileState(previous: TileState, result: RefreshBalanceResult): TileState {
  if (result.ok && result.balance !== null) return { balance: result.balance, syncedAt: result.syncedAt, failure: null };
  const failure = result.message ?? CIRCLE_UNREACHABLE;
  if (result.balance !== null && result.syncedAt !== null) return { balance: result.balance, syncedAt: result.syncedAt, failure };
  return { ...previous, failure };
}

/**
 * The balance tile in live mode: the stored balance at once, then one read of
 * the chain in the background when the tile mounts, and again on Refresh. A
 * failed read keeps the last known number and says so beside its age; it never
 * shows an error of Circle's, which the action does not return. `BalanceTile`
 * keys it on the server's figures, so new ones remount it.
 */
export function LiveBalanceTile({
  orgSlug,
  refreshAction,
  label,
  sub,
  initialBalance,
  offset,
  initialSyncedAt,
}: {
  orgSlug: string;
  /** `refreshOnChainBalanceAction`, handed down by the page so this module never imports the server's. */
  refreshAction: (orgSlug: string) => Promise<RefreshBalanceResult>;
  label: string;
  sub?: ReactNode;
  /** The non-reserve accounts' stored total: what the refresh answers with. */
  initialBalance: number;
  /** Added to it for display: a reserve held on chain, which the refresh does not read. */
  offset: number;
  initialSyncedAt: string | null;
}) {
  const [state, refresh, pending] = useActionState(
    async (previous: TileState): Promise<TileState> => {
      try {
        return nextTileState(previous, await refreshAction(orgSlug));
      } catch {
        return { ...previous, failure: CIRCLE_UNREACHABLE };
      }
    },
    { balance: initialBalance, syncedAt: initialSyncedAt, failure: null }
  );
  const now = useSyncExternalStore(subscribeClock, clockNow, noClock);
  const requested = useRef(false);

  useEffect(() => {
    // Once per mount, however often a development build runs this effect.
    if (requested.current) return;
    requested.current = true;
    startTransition(() => refresh());
  }, [refresh]);

  return (
    <LiveBalanceView
      label={label}
      sub={sub}
      balance={state.balance + offset}
      syncedAt={state.syncedAt}
      now={now}
      pending={pending}
      failure={state.failure}
      onRefresh={() => startTransition(() => refresh())}
    />
  );
}
