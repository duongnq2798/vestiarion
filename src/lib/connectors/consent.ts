import { PROVIDER_LABELS, type AccountingProviderId, type ProviderId } from "./provider";

/**
 * What a person agrees to before connecting an accounting tool (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X12, docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q13), in plain words, with the version recorded
 * on the connection and in its signed entry. A change to these words is a new version; a connection keeps the version
 * it agreed to. Browser-safe.
 */

export const CONSENT_VERSIONS: Record<ProviderId, string> = {
  xero: "xero-2026-10-13",
  quickbooks: "quickbooks-2026-10-12",
  hubspot: "hubspot-2026-10-13",
  asana: "asana-2026-10-14",
};

/**
 * The versions under which an accountant may approve bookings (accountant console A1): those whose words name the
 * accountant. A connection that agreed to an earlier version, where only an owner or admin approves, keeps that until it
 * connects again; an accountant's booking there is refused with what to do.
 */
export const ACCOUNTANT_BOOKING_CONSENTS: ReadonlySet<string> = new Set(["xero-2026-10-13"]);

/**
 * A CRM's statement (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H14): its companies, contacts and
 * deals; and, from version 2026-10-13, what is written back once an owner or admin allows it
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3). The first version said it writes nothing; a connection
 * keeps the version it agreed to until it connects again.
 */
const CRM_STATEMENT = (label: string) => [
  `Vestiarion reads the companies, contacts and deals of the ${label} account you connect: names, amounts, close dates, pipeline stages and each company's main contact email.`,
  `It writes to ${label} only once an owner or admin allows it: then, on each ${label} deal planned in Vestiarion, what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion, in a Vestiarion property group it creates. It never changes ${label}'s own deal fields, and writes payments on Arc testnet or in shadow mode only to a ${label} developer test account or sandbox.`,
  `They are shown to this workspace's members and to its agent. The agent's model provider may see a deal's facts to decide on its collections, and may not train on them.`,
  `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
  `Disconnecting stops the reading at once. Deals already planned stay in Vestiarion.`,
];

/**
 * What is read, in each tool's own words: Xero's chart of accounts, QuickBooks' bank accounts only; and what is written.
 * Xero's version 2 says it books the payments a person approves (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W8, W12), and version 2026-10-13 names the accountant among those who approve (accountant console A1); its first version
 * said it writes nothing, and a connection keeps the version it agreed to until it connects again.
 */
const WHAT_IS_READ: Record<AccountingProviderId, string> = {
  xero: "Vestiarion reads the bills, suppliers and chart of accounts of the Xero organisation you pick. It writes to Xero only the payments an owner, admin or accountant approves: each payment made on Arc for a bill brought in from Xero, booked against that bill.",
  quickbooks: "Vestiarion reads the bills, vendors and bank accounts of the QuickBooks company you connect. It writes nothing to QuickBooks.",
};

/**
 * A work tool's statement (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A15): what is read of the
 * tasks linked to milestones, the webhooks it makes on them, and that nothing from it moves money.
 */
const WORK_STATEMENT = (label: string) => [
  `Vestiarion reads, as the ${label} user who connects, the workspaces, projects and tasks you open to link a task to a milestone. For each linked task it reads its name, whether and when it was completed and by whom, its assignee, and the links in its description, attachments and comments. It keeps the links and names, not the words of the description or the comments.`,
  `It makes a ${label} webhook on each linked task, so a change there is read again within a minute, and deletes it when the task is unlinked or ${label} is disconnected. It looks up a member's or a payee's email in ${label} only to stop anyone accepting their own work. It writes nothing else to ${label}.`,
  `A task completed in ${label} is never by itself a reason to pay: a person here accepts the work against the milestone's criteria, and the agent then decides the payment under every guardrail. Nothing from ${label} sets an amount or a payee.`,
  `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
  `Disconnecting stops the reading at once and deletes the webhooks. Acceptances already recorded stay in Vestiarion's signed ledger.`,
];

export function consentStatement(provider: ProviderId): string[] {
  const label = PROVIDER_LABELS[provider];
  if (provider === "hubspot") return CRM_STATEMENT(label);
  if (provider === "asana") return WORK_STATEMENT(label);
  return [
    WHAT_IS_READ[provider],
    `The bills you add are shown to this workspace's members and to its agent. The agent's model provider sees each bill's facts to decide on it, and may not train on them.`,
    `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
    `Disconnecting stops the reading at once. Bills already added stay in Vestiarion.`,
  ];
}

/** The box a person ticks. */
export const CONSENT_LABEL = "I agree";
