import { NoOrgScopeError, currentOrgId } from "../context";
import { db } from "../dal";
import { withOrg } from "../dal/scope";
import type { CostCurrency, UsageKind } from "./model";

/**
 * Recording what a workspace used (docs/superpowers/specs/2026-10-13-accountant-console-design.md U1): one
 * `usage_events` row, written through the workspace's own tenant client, for a model call, a Circle transfer, an x402
 * purchase, an email or a connector sync.
 *
 * Best effort, always: it never throws and never delays what it records by more than one insert. Outside an
 * organization's scope (a script, the ambient context) it records nothing, and before migration 0112 runs the missing
 * table is not an error worth logging. What failed is logged by kind and action only, never with the row.
 */

export interface UsageEvent {
  kind: UsageKind;
  /** What it was for, in the app's own words: `^[a-z][a-z0-9_]{0,39}$`. */
  action: string;
  provider?: string | null;
  model?: string | null;
  quantity?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** A decimal string or number, in its own currency; null when not known. */
  cost?: { amount: string | number; currency: CostCurrency } | null;
  ok?: boolean;
}

const ACTION = /^[a-z][a-z0-9_]{0,39}$/;
const PROVIDER = /^[a-z][a-z0-9_.-]{0,39}$/;

function tokens(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 100_000_000) : null;
}

function costAmount(value: string | number): string | null {
  const text = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? value.toFixed(6) : "") : value.trim();
  return /^\d{1,13}(\.\d{1,12})?$/.test(text) ? text : null;
}

/** The row as the table takes it, or null when the event does not describe one (a bug in a caller, logged by kind). */
export function usageRow(event: UsageEvent): Record<string, unknown> | null {
  if (!ACTION.test(event.action)) return null;
  const amount = event.cost ? costAmount(event.cost.amount) : null;
  return {
    kind: event.kind,
    action: event.action,
    provider: event.provider && PROVIDER.test(event.provider) ? event.provider : null,
    model: event.model ? event.model.slice(0, 80) : null,
    quantity: Math.min(Math.max(1, Math.round(event.quantity ?? 1)), 1_000_000),
    input_tokens: tokens(event.inputTokens),
    output_tokens: tokens(event.outputTokens),
    cost: amount,
    cost_currency: amount === null ? null : event.cost?.currency ?? null,
    ok: event.ok ?? true,
  };
}

function notSetUp(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

export async function recordUsage(event: UsageEvent): Promise<void> {
  try {
    currentOrgId();
    const row = usageRow(event);
    if (!row) {
      console.error("usage: an event that does not read was not recorded", event.kind);
      return;
    }
    const { error } = await db().from("usage_events").insert(row);
    if (error && !notSetUp(error)) console.error("usage: not recorded", event.kind, event.action);
  } catch (error) {
    // Outside an organization's scope there is nothing to record against, and nothing to say.
    if (error instanceof NoOrgScopeError) return;
    console.error("usage: not recorded", event.kind, event.action);
  }
}

/**
 * The same, for work done outside the workspace's scope (an email sent after a payee's or a customer's request, which
 * no member's request carries): it enters the workspace's own scope to write, so the row still goes through its tenant
 * client. Never throws.
 */
export async function recordUsageFor(orgId: string, event: UsageEvent): Promise<void> {
  try {
    await withOrg(orgId, () => recordUsage(event));
  } catch {
    console.error("usage: not recorded", event.kind, event.action);
  }
}
