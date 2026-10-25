import type { Connection } from "../connectors/connections";
import { syncErrorWords } from "../connectors/status";
import { db } from "../dal";

/**
 * A Google Sheets connection Google no longer accepts (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS13): its access was removed in the Google Account, it went unused for six months, or the grant lacks the Drive
 * permission. It then needs a person, and says so in Google's words; `connectionStatus` and the accountant console's
 * problems list show it as for any connector. Only a connected one moves, as Asana's `markReconnect`.
 */
export async function markSheetsReconnect(connection: Connection, nowIso: string): Promise<void> {
  const updated = await db()
    .from("accounting_connections")
    .update({ status: "needs_reconnect", last_error: syncErrorWords("reconnect", "Google Sheets", null), last_error_at: nowIso })
    .eq("id", connection.id)
    .eq("status", "connected")
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
}
