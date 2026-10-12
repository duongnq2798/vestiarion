import { PROVIDER_LABELS, type ProviderId } from "./provider";

/**
 * What a person agrees to before connecting an accounting tool (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X12), in plain words, with the version recorded on the connection and in its signed entry. A change to these words is
 * a new version; a connection keeps the version it agreed to. Browser-safe.
 */

export const CONSENT_VERSIONS: Record<ProviderId, string> = { xero: "xero-2026-10-12.2", quickbooks: "quickbooks-2026-10-12" };

/**
 * Whether a provider books the payments a person approves (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W8, W12): what it writes is said before anyone connects it. Xero's version 2 says so; its first version said it
 * writes nothing, and a connection keeps the version it agreed to until it connects again.
 */
const BOOKS: Record<ProviderId, boolean> = { xero: true, quickbooks: false };

export function consentStatement(provider: ProviderId): string[] {
  const label = PROVIDER_LABELS[provider];
  return [
    BOOKS[provider]
      ? `Vestiarion reads the bills, suppliers and chart of accounts of the ${label} organisation you pick. It writes to ${label} only the payments an owner or admin approves: each payment made on Arc for a bill brought in from ${label}, booked against that bill.`
      : `Vestiarion reads the bills, suppliers and chart of accounts of the ${label} organisation you pick. It writes nothing to ${label}.`,
    `The bills you add are shown to this workspace's members and to its agent. The agent's model provider sees each bill's facts to decide on it, and may not train on them.`,
    `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
    `Disconnecting stops the reading at once. Bills already added stay in Vestiarion.`,
  ];
}

/** The box a person ticks. */
export const CONSENT_LABEL = "I agree";
