/**
 * A connection's status in business words (docs/superpowers/specs/2026-10-12-xero-connector-design.md X15), from its
 * row alone. Never "connected" while the last sync failed: a failure newer than the last success turns the title to
 * the failure. In the provider's own words (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q15); a
 * CRM's words speak of its deals (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H16). Pure and
 * browser-safe.
 */

import { providerKind, providerWords } from "./provider";

export type ConnectionState = "connected" | "needs_reconnect" | "revoked";

export interface ConnectionFacts {
  providerLabel: string;
  status: ConnectionState;
  externalOrgName: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** A run stopped on a checkpoint, and how many pages it read. */
  syncing: { pagesRead: number } | null;
}

export interface StatusView {
  tone: "ok" | "error" | "off";
  title: string;
  detail: string[];
  /** Whether the card offers to reconnect. */
  reconnect: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "1 minute ago", "3 hours ago", "3 days ago". */
export function ago(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "14:05 UTC", with the day when it is not today's: "08:00 UTC on Oct 13". */
function clock(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const time = `${at.toISOString().slice(11, 16)} UTC`;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return at.toISOString().slice(0, 10) === today ? time : `${time} on ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/**
 * An export tool's grant (close pack Sheets GS13): Google ends it when its access is removed in the Google Account, or
 * after six months unused. Google Sheets is the one export tool, so its words name Google.
 */
const EXPORT_RECONNECT = (label: string) =>
  `Google no longer accepts this connection: its access was removed in the Google Account, or it went unused for six months. Reconnect ${label} to export ${providerWords(label).bills} again.`;

const reconnectWords = (label: string) =>
  providerKind(label) === "export"
    ? EXPORT_RECONNECT(label)
    : providerKind(label) === "work"
    ? `${label} no longer accepts this connection: the app's access was removed in ${label}. Reconnect ${label} to go on reading the tasks linked to milestones.`
    : providerKind(label) === "crm"
      ? `${label} no longer accepts this connection: the app was uninstalled in ${label}, or its access was removed. Reconnect ${label} to go on bringing its deals in.`
      : providerWords(label).idleDays > 0
        ? `${label} no longer accepts this connection: it was disconnected in ${label}, or not used for ${providerWords(label).idleDays} days. Reconnect ${label} to go on bringing its bills in.`
        : // A refresh token that lasts until revoked (Zoho Books, Z1): only a person ends it.
          `${label} no longer accepts this connection: it was disconnected in ${label}, or its access was revoked. Reconnect ${label} to go on bringing its bills in.`;

export type SyncErrorKind = "rate_limited" | "unavailable" | "bad_response" | "failed" | "reconnect";

/** What the card says of a run that stopped, with the time the next one may start. */
export function syncErrorWords(kind: SyncErrorKind, label: string, nextAt: string | null, nowMs: number = nextAt ? Date.parse(nextAt) : Date.now()): string {
  if (kind === "reconnect") return reconnectWords(label);
  const when = nextAt ? clock(nextAt, nowMs) : "shortly";
  switch (kind) {
    case "rate_limited":
      return `${label} asked Vestiarion to slow down. Syncing again at ${when}.`;
    case "unavailable":
      return `${label} did not answer. Vestiarion tries again at ${when}.`;
    case "bad_response":
      return `${providerWords(label).possessive} answer could not be read. Vestiarion tries again at ${when}.`;
    case "failed":
      return `The sync stopped on an error. Vestiarion tries again at ${when}.`;
  }
}

export function connectionStatus(facts: ConnectionFacts, nowMs: number): StatusView {
  const label = facts.providerLabel;
  const kind = providerKind(label);
  const crm = kind === "crm";
  const name = facts.externalOrgName ?? `your ${label} ${providerWords(label).organisation}`;
  if (facts.status === "revoked") {
    // An export tool reads nothing: what it was given stays where it was written (close pack Sheets GS14).
    if (kind === "export") {
      return { tone: "off", title: `Disconnected from ${name}`, detail: [`Spreadsheets already exported stay in that Google Drive. Nothing more is written to ${label}.`], reconnect: false };
    }
    const kept = kind === "work" ? "Acceptances already recorded stay in Vestiarion." : crm ? "Deals already planned stay in Vestiarion." : "Bills already added stay in Vestiarion.";
    return { tone: "off", title: `Disconnected from ${name}`, detail: [`${kept} Nothing more is read from ${label}.`], reconnect: false };
  }
  if (facts.status === "needs_reconnect") {
    return {
      tone: "error",
      title: `${label} needs you to reconnect`,
      detail: [
        facts.lastError ??
          (kind === "work" || kind === "export"
            ? reconnectWords(label)
            : `${label} no longer accepts this connection. Reconnect ${label} to go on bringing its ${crm ? "deals" : "bills"} in.`),
      ],
      reconnect: true,
    };
  }
  // An export tool never syncs: a person exports to it (close pack Sheets GS15).
  if (kind === "export") {
    return { tone: "ok", title: `Connected to ${name}`, detail: ["An owner, admin or accountant exports a month from Monthly close pack in the Audit log."], reconnect: false };
  }
  const synced = facts.lastSyncedAt ? `Last synced ${ago(facts.lastSyncedAt, nowMs)}.` : null;
  const failedSince =
    facts.lastError !== null && (facts.lastSyncedAt === null || (facts.lastErrorAt !== null && Date.parse(facts.lastErrorAt) >= Date.parse(facts.lastSyncedAt)));
  if (failedSince && facts.lastError) {
    return { tone: "error", title: `The last sync with ${label} failed`, detail: [facts.lastError, synced ?? "Not synced yet."], reconnect: false };
  }
  const detail = [synced ?? "Not synced yet. The first sync starts in a moment."];
  if (facts.syncing) detail.push(`Syncing: ${facts.syncing.pagesRead} of ${providerWords(label).possessive} pages read so far.`);
  return { tone: "ok", title: `Connected to ${name}`, detail, reconnect: false };
}
