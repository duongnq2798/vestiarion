import { platformDb } from "../dal";
import { isMissingRelation } from "../extension/tokens";

/**
 * Invoice capture's retention, run by the daily cleanup (docs/superpowers/specs/2026-10-15-invoice-capture-design.md
 * C9, C10): the captured text goes 30 days after capture, drafts never sent go after 7, used-up codes after a day and
 * ended connections after 30, all in `invoice_capture_sweep` (migration 0121). Counts only, never a row. Never throws:
 * before migration 0121 there is nothing to sweep, which is no failure.
 */
export interface CaptureSweep {
  swept: { textCleared: number; draftsDeleted: number; codesDeleted: number; connectionsDeleted: number } | null;
  failed: number;
}

export async function sweepInvoiceCapture(now: Date = new Date()): Promise<CaptureSweep> {
  try {
    const { data, error } = await platformDb().rpc("invoice_capture_sweep", { p_now: now.toISOString() });
    if (error) {
      if (isMissingRelation(error)) return { swept: null, failed: 0 };
      console.error("invoice capture retention failed", error.message);
      return { swept: null, failed: 1 };
    }
    return { swept: data as CaptureSweep["swept"], failed: 0 };
  } catch (error) {
    console.error("invoice capture retention failed", error instanceof Error ? error.message : "unknown error");
    return { swept: null, failed: 1 };
  }
}
