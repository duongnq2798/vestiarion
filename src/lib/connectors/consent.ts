import type { LlmProvider } from "../config";
import { PROVIDER_LABELS, type AccountingProviderId, type ProviderId } from "./provider";

/**
 * What a person agrees to before connecting an accounting tool (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X12, docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q13), in plain words, with the version recorded
 * on the connection and in its signed entry. A change to what these words say is a new version (a grammar fix that
 * says the same is not); a connection keeps the version it agreed to. Browser-safe.
 *
 * Versions 2026-10-15 say the agent's model provider sees (a CRM's: may see) the facts under that provider's own API
 * terms; the versions before them promised the provider would not train on them, which DeepSeek's terms do not say.
 *
 * The connect page posts the version it showed, and the connect route records it only when it is still the current one
 * (`startConnect`), so a connection's version is always the words the person read.
 */

export const CONSENT_VERSIONS: Record<ProviderId, string> = {
  xero: "xero-2026-10-15",
  quickbooks: "quickbooks-2026-10-15",
  hubspot: "hubspot-2026-10-15",
  pipedrive: "pipedrive-2026-10-15",
  asana: "asana-2026-10-14",
  zohobooks: "zohobooks-2026-10-16",
};

/**
 * Every version each statement has had, oldest first; the last is the one in `CONSENT_VERSIONS`. Connections agreed to
 * each of them may still be live, so a gate on versions (such as `ACCOUNTANT_BOOKING_CONSENTS`) names every one whose
 * words cover what it allows, and a new version joins each gate the one before it was in, unless its words take that away.
 */
export const CONSENT_HISTORY: Record<ProviderId, readonly string[]> = {
  xero: ["xero-2026-10-12", "xero-2026-10-12.2", "xero-2026-10-13", "xero-2026-10-15"],
  quickbooks: ["quickbooks-2026-10-12", "quickbooks-2026-10-15"],
  hubspot: ["hubspot-2026-10-12", "hubspot-2026-10-13", "hubspot-2026-10-15"],
  pipedrive: ["pipedrive-2026-10-14", "pipedrive-2026-10-15"],
  asana: ["asana-2026-10-14"],
  zohobooks: ["zohobooks-2026-10-16"],
};

/**
 * The hosted service's model provider, which the statements name: the hosted deployment pins `AGENT_LLM_PROVIDER` to
 * its `id`. Its API terms, and its privacy policy, which says what it does with what it is sent. Changing the hosted
 * provider changes what people agreed to, so it takes a new version of every statement that names it.
 */
export const HOSTED_MODEL_PROVIDER = {
  id: "deepseek",
  name: "DeepSeek",
  terms: "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
  privacy: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
} as const satisfies { id: LlmProvider; name: string; terms: string; privacy: string };

/** How a statement names the model provider; a line that does is shown with links to its terms and privacy policy. */
const MODEL_PROVIDER = `The agent's model provider (${HOSTED_MODEL_PROVIDER.name}, on the hosted service)`;

/** Whether a line of a statement names the model provider. */
export const namesModelProvider = (line: string) => line.includes(MODEL_PROVIDER);

/** What the connect page says when the statement changed between showing it and the person agreeing. */
export const CONSENT_CHANGED = "The statement changed since this page loaded. Read it again.";

/**
 * The versions under which an accountant may approve bookings (accountant console A1): those whose words name the
 * accountant, 2026-10-13 and 2026-10-15. A connection that agreed to an earlier version, where only an owner or admin
 * approves, keeps that until it connects again; an accountant's booking there is refused with what to do.
 */
export const ACCOUNTANT_BOOKING_CONSENTS: ReadonlySet<string> = new Set(["xero-2026-10-13", "xero-2026-10-15"]);

/**
 * A CRM's statement (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H14): its companies, contacts and
 * deals; and, from version 2026-10-13, what is written back once an owner or admin allows it
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3); and, from version 2026-10-15, that the model provider
 * may see a deal's facts, when a reminder is weighed, under its own API terms. The first version said it writes nothing; a connection keeps the version
 * it agreed to until it connects again.
 */
const CRM_STATEMENT = (label: string) => [
  `Vestiarion reads the companies, contacts and deals of the ${label} account you connect: names, amounts, close dates, pipeline stages and each company's main contact email.`,
  `It writes to ${label} only once an owner or admin allows it: then, on each ${label} deal planned in Vestiarion, what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion, in a Vestiarion property group it creates. It never changes ${label}'s own deal fields, and writes payments on Arc testnet or in shadow mode only to a ${label} developer test account or sandbox.`,
  `They are shown to this workspace's members and to its agent. ${MODEL_PROVIDER} may see a deal's facts to decide on its collections, under that provider's own API terms.`,
  `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
  `Disconnecting stops the reading at once. Deals already planned stay in Vestiarion.`,
];

/**
 * Pipedrive's statement (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P14): its deals with their
 * organizations and persons, the change notices it sends, and what is written once allowed. Pipedrive names no test
 * company, so payments on Arc testnet or in shadow mode are never written to it (P12). Version 2026-10-15 says the model
 * provider may see a deal's facts under its own API terms, and that disconnecting revokes the access, which Pipedrive
 * documents as uninstalling the app: Vestiarion only calls Pipedrive's revoke endpoint.
 */
const PIPEDRIVE_STATEMENT: readonly string[] = [
  "Vestiarion reads the deals of the Pipedrive company you connect, with their organizations and persons: titles, values, close dates, pipeline stages, organization names and each person's email. It sees the deals the Pipedrive user who connects can see.",
  "Pipedrive tells Vestiarion when a deal changes, and Vestiarion then reads it again from Pipedrive. What a notice says is never used as it is.",
  "It writes to Pipedrive only once an owner or admin allows it: then, on each Pipedrive deal planned in Vestiarion, what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion, in Vestiarion deal fields it creates. It never changes Pipedrive's own deal fields, and never writes payments on Arc testnet or in shadow mode to Pipedrive.",
  `They are shown to this workspace's members and to its agent. ${MODEL_PROVIDER} may see a deal's facts to decide on its collections, under that provider's own API terms.`,
  "Vestiarion never uses Pipedrive data to train or improve any AI model, and never passes it to anyone else without your workspace's say.",
  "Disconnecting stops the reading at once and revokes Vestiarion's access, which, as Pipedrive documents it, uninstalls Vestiarion from your Pipedrive company. Deals already planned stay in Vestiarion.",
];

/**
 * What is read, in each tool's own words: Xero's chart of accounts, QuickBooks' bank accounts only; and what is written.
 * Xero's version 2 says it books the payments a person approves (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W8, W12), and versions 2026-10-13 and 2026-10-15 name the accountant among those who approve (accountant console A1);
 * its first version said it writes nothing, and a connection keeps the version it agreed to until it connects again.
 */
const WHAT_IS_READ: Record<AccountingProviderId, string> = {
  xero: "Vestiarion reads the bills, suppliers and chart of accounts of the Xero organisation you pick. It writes to Xero only the payments an owner, admin or accountant approves: each payment made on Arc for a bill brought in from Xero, booked against that bill.",
  quickbooks: "Vestiarion reads the bills, vendors and bank accounts of the QuickBooks company you connect. It writes nothing to QuickBooks.",
  zohobooks: "Vestiarion reads the bills and vendors of the Zoho Books organization you pick, and the names of the organizations you can reach. It writes nothing to Zoho Books.",
};

/**
 * A work tool's statement (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A15): what is read of the
 * tasks linked to milestones, the webhooks it makes on them, and that nothing from it moves money.
 */
const WORK_STATEMENT = (label: string) => [
  `Vestiarion reads, as the ${label} user who connects, the workspaces, projects and tasks you open to link a task to a milestone. For each linked task it reads its name, whether and when it was completed and by whom, its assignee, and the links in its description, attachments and comments. It keeps the links and names, not the words of the description or the comments.`,
  `It makes a webhook in ${label} on each linked task, so a change there is read again within a minute, and deletes it when the task is unlinked or ${label} is disconnected. It looks up a member's or a payee's email in ${label} only to refuse an acceptance by the payee. It writes nothing else to ${label}.`,
  `A task completed in ${label} is never by itself a reason to pay: a person here accepts the work against the milestone's criteria, and the agent then decides the payment under every guardrail. Nothing from ${label} sets an amount or a payee.`,
  `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
  `Disconnecting stops the reading at once and deletes the webhooks. Acceptances already recorded stay in Vestiarion's signed ledger.`,
];

export function consentStatement(provider: ProviderId): string[] {
  const label = PROVIDER_LABELS[provider];
  if (provider === "hubspot") return CRM_STATEMENT(label);
  if (provider === "pipedrive") return [...PIPEDRIVE_STATEMENT];
  if (provider === "asana") return WORK_STATEMENT(label);
  return [
    WHAT_IS_READ[provider],
    `The bills you add are shown to this workspace's members and to its agent. ${MODEL_PROVIDER} sees each bill's facts to decide on it, under that provider's own API terms.`,
    `Vestiarion never uses ${label} data to train or improve any AI model, and never passes it to anyone else without your workspace's say.`,
    `Disconnecting stops the reading at once. Bills already added stay in Vestiarion.`,
  ];
}

/** The box a person ticks. */
export const CONSENT_LABEL = "I agree";
