import { walletIdempotencyKey } from "./circle/provision";

/**
 * Test USDC for shadow mode, the rules (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T3, T4, T8). Pure:
 * how much a workspace takes from Vestiarion's float, what it took this week, the key that keeps two clicks to one
 * transfer, and what the console says.
 */

export const DEFAULT_WEEKLY_LIMIT = 5000;
export const WEEK_MS = 7 * 86_400_000;
const MINIMUM = 1;

/** Up to the next cent; a figure already on a cent stays. */
export function ceilCents(value: number): number {
  // Rounded to a ten-thousandth of a cent first, so 480.1's binary error does not lift it to 480.11.
  return Math.ceil(Math.round(value * 1e6) / 1e4) / 100;
}

/** Down to the cent: what is left to take is never rounded up. */
const floorCents = (value: number) => Math.floor(Math.round(value * 1e6) / 1e4) / 100;

export type TestUsdcRefusal = "nothing_needed" | "limit_reached" | "float_empty";

/** What to add: the shortfall (minus safe to spend), at least 1 USDC, within the week's limit and the float's USDC. */
export function testUsdcAmount(input: {
  safeToSpend: number;
  takenThisWeek: number;
  weeklyLimit: number;
  floatBalance: number;
}): { amount: number; shortfall: number } | { refused: TestUsdcRefusal; shortfall: number } {
  if (!(input.safeToSpend < 0)) return { refused: "nothing_needed", shortfall: 0 };
  const shortfall = ceilCents(-input.safeToSpend);
  const left = floorCents(input.weeklyLimit - input.takenThisWeek);
  if (left < MINIMUM) return { refused: "limit_reached", shortfall };
  const float = floorCents(input.floatBalance);
  if (float < MINIMUM) return { refused: "float_empty", shortfall };
  return { amount: Math.min(Math.max(shortfall, MINIMUM), left, float), shortfall };
}

export interface GrantEntry {
  ts: string;
  detail: { amount?: unknown; status?: unknown };
}

/**
 * The USDC a workspace's `test_usdc_added` entries took in the 7 days before `now`. One still processing counts; one
 * Circle reported failed moved nothing, so it does not.
 */
export function takenInWindow(entries: GrantEntry[], now: number): number {
  return entries.reduce((sum, entry) => {
    const at = Date.parse(entry.ts);
    const amount = Number(entry.detail?.amount);
    const counted = Number.isFinite(at) && at > now - WEEK_MS && Number.isFinite(amount) && amount > 0 && entry.detail?.status !== "failed";
    return counted ? sum + amount : sum;
  }, 0);
}

/** Circle's idempotency key for a workspace's grant number `ordinal`: two clicks that counted the same entries share it. */
export function testUsdcKey(orgId: string, ordinal: number): string {
  return walletIdempotencyKey(orgId, `test-usdc:${ordinal}`);
}

export type TestUsdcView =
  | { need: number; action: "add"; amount: number }
  | { need: number; action: "limit"; weeklyLimit: number }
  | { need: number; action: null };

/** What the console's shadow mode section says about test USDC; nothing when safe to spend is not below zero. */
export function testUsdcView(input: {
  safeToSpend: number;
  takenThisWeek: number;
  weeklyLimit: number;
  available: boolean;
  canAdd: boolean;
}): TestUsdcView | null {
  if (!(input.safeToSpend < 0)) return null;
  const need = ceilCents(-input.safeToSpend);
  if (!input.available || !input.canAdd) return { need, action: null };
  const left = floorCents(input.weeklyLimit - input.takenThisWeek);
  if (left < MINIMUM) return { need, action: "limit", weeklyLimit: input.weeklyLimit };
  return { need, action: "add", amount: Math.min(Math.max(need, MINIMUM), left) };
}
