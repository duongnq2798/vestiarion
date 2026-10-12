import { PROVIDER_LABELS, type ProviderId } from "./provider";

/**
 * What a person agrees to before connecting an accounting tool (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X12), in plain words, with the version recorded on the connection and in its signed entry. A change to these words is
 * a new version; a connection keeps the version it agreed to. Browser-safe.
 */

export const CONSENT_VERSIONS: Record<ProviderId, string> = { xero: "xero-2026-10-12", quickbooks: "quickbooks-2026-10-12", hubspot: "hubspot-2026-10-12" };

/** A CRM's statement (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H14): its companies, contacts and deals. */
const CRM_STATEMENT = (label: string) => [
  `Vestiarion reads the companies, contacts and deals of the ${label} account you connect: names, amounts, close dates, pipeline stages and each company's main contact email. It writes nothing to ${label}.`,
  `They are shown to this workspace's members and to its agent. The agent's model provider may see a deal's facts to decide on its collections, and may not train on them.`,
  `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
  `Disconnecting stops the reading at once. Deals already planned stay in Vestiarion.`,
];

export function consentStatement(provider: ProviderId): string[] {
  const label = PROVIDER_LABELS[provider];
  if (provider === "hubspot") return CRM_STATEMENT(label);
  return [
    `Vestiarion reads the bills, suppliers and chart of accounts of the ${label} organisation you pick. It writes nothing to ${label}.`,
    `The bills you add are shown to this workspace's members and to its agent. The agent's model provider sees each bill's facts to decide on it, and may not train on them.`,
    `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
    `Disconnecting stops the reading at once. Bills already added stay in Vestiarion.`,
  ];
}

/** The box a person ticks. */
export const CONSENT_LABEL = "I agree";
