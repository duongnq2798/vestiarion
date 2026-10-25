import { can, type OrgRole } from "../auth/roles";
import type { Connection } from "../connectors/connections";
import { syncErrorWords } from "../connectors/status";

/**
 * What the Settings card and the close pack page show of Google Sheets
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS5, GS6, "Screens and copy"), built on the
 * server from the connection and the ledger, so the browser gets words and a checked link, never a token or a full
 * email. Pure and browser-safe: the components import this file only.
 */

export type GoogleSheetsPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | { state: "connected"; account: string; connectedAt: string }
  | { state: "needs_reconnect"; account: string; words: string }
  | { state: "revoked"; account: string };

export type ClosePackSheetsView =
  | { state: "hidden" }
  | { state: "connect"; canConnect: boolean }
  | { state: "reconnect"; canConnect: boolean }
  | { state: "ready"; account: string; canExport: boolean; last: { at: string; payments: number; url: string } | null };

/** The account when Google gave no email (GS6). */
export const NO_ACCOUNT_NAME = "A Google account";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 25", in UTC, built by hand so a server render and the browser read the same words. */
function cardDay(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** The card's state from the workspace's connection: null is one never connected. */
export function googleSheetsPanelView(connection: Connection | null): GoogleSheetsPanelView {
  if (!connection) return { state: "not_connected" };
  const account = connection.externalOrgName ?? NO_ACCOUNT_NAME;
  if (connection.status === "revoked") return { state: "revoked", account };
  if (connection.status === "needs_reconnect") return { state: "needs_reconnect", account, words: connection.lastError ?? syncErrorWords("reconnect", "Google Sheets", null) };
  return { state: "connected", account, connectedAt: cardDay(connection.connectedAt) };
}

/**
 * The close pack page's control (GS5): hidden when Google Sheets is off or not set up; for an approver or a viewer,
 * hidden unless the month can be shown as exported, and then without the button. Connecting and reconnecting are an
 * owner's or admin's (`integrations.manage`); exporting an owner's, admin's or accountant's (`accounting.book`).
 */
export function closePackSheetsViewOf(input: {
  panel: GoogleSheetsPanelView | null;
  role: OrgRole;
  last: { at: string; payments: number; url: string } | null;
}): ClosePackSheetsView {
  const { panel, role } = input;
  if (!panel || panel.state === "not_set_up") return { state: "hidden" };
  const canConnect = can(role, "integrations.manage");
  const canExport = can(role, "accounting.book");
  if (panel.state === "connected") return { state: "ready", account: panel.account, canExport, last: input.last };
  if (!canExport) return { state: "hidden" };
  return { state: panel.state === "needs_reconnect" ? "reconnect" : "connect", canConnect };
}
