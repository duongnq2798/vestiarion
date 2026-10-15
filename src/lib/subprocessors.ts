/**
 * The services that process data for Vestiarion, as the security page lists them. The privacy page says in full what
 * each one receives; `tests/security-page.test.tsx` holds the two pages to the same services, so a service named on
 * one and not the other fails there.
 */

/** The day this list was last checked against the code. */
export const SUBPROCESSORS_AS_OF = "2026-10-15";

export interface Subprocessor {
  /** The service, as the security page names it. */
  name: string;
  /** The name of its entry under "Services that receive data" on the privacy page. */
  privacyEntry: string;
  /** Each name the privacy page must also say, such as each model provider. */
  names: readonly string[];
  /** What it does for Vestiarion. */
  purpose: string;
  /** What it receives. */
  data: string;
  /** When it receives anything: always, when this deployment configures it, or once a member connects it. */
  when: "always" | "configured" | "connected";
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Vercel",
    privacyEntry: "Vercel",
    names: ["Vercel"],
    purpose: "hosts the app and runs its server code",
    data: "every request to the app and its API, and the app's answers",
    when: "always",
  },
  {
    name: "Supabase",
    privacyEntry: "Supabase",
    names: ["Supabase"],
    purpose: "holds the Postgres database and runs sign-in",
    data: "everything a workspace stores, and each person's sign-in account",
    when: "always",
  },
  {
    name: "Circle",
    privacyEntry: "Circle",
    names: ["Circle"],
    purpose: "creates the wallets and moves the payments, through Developer-Controlled Wallets, CCTP, Gateway, its Smart Contract Platform, its Stablecoin Service and Modular Wallets",
    data: "wallet addresses, payment amounts and signed x402 payments, and a passkey's public key for a passkey wallet",
    when: "always",
  },
  {
    name: "Resend",
    privacyEntry: "Resend",
    names: ["Resend"],
    purpose: "sends transactional email, and receives the emails sent to a workspace's invoice address",
    data: "each recipient's email address and the message, and the emails that reach an invoice address",
    when: "configured",
  },
  {
    name: "Anthropic, OpenAI or DeepSeek",
    privacyEntry: "A model provider",
    names: ["Anthropic", "OpenAI", "DeepSeek"],
    purpose: "proposes the agent's decisions",
    data: "the facts of each decision the agent asks it about, and a document or message a member chooses to have read",
    when: "configured",
  },
  {
    name: "OpenSanctions",
    privacyEntry: "OpenSanctions",
    names: ["OpenSanctions"],
    purpose: "screens counterparties against sanctions lists",
    data: "the names and jurisdictions of a live workspace's counterparties",
    when: "configured",
  },
  {
    name: "ExchangeRate-API",
    privacyEntry: "ExchangeRate-API",
    names: ["ExchangeRate-API"],
    purpose: "gives the day's rates against the US dollar",
    data: "nothing about you, your workspace or your bills",
    when: "always",
  },
  {
    name: "Arc RPC nodes",
    privacyEntry: "Arc RPC nodes",
    names: ["Arc RPC nodes"],
    purpose: "answer reads of balances, fees and receipts on Arc, and on a payee's chain for a payout to another chain",
    data: "the wallet addresses and transaction hashes read, which are already public on chain",
    when: "always",
  },
  {
    name: "Telegram",
    privacyEntry: "Telegram",
    names: ["Telegram"],
    purpose: "sends the bot's messages to a member who connects their chat",
    data: "the agent's decisions with counterparties' names, amounts and reasons, and the answers to the member's questions",
    when: "connected",
  },
  {
    name: "Slack",
    privacyEntry: "Slack",
    names: ["Slack"],
    purpose: "receives the posts and answers for a workspace connected to a Slack channel",
    data: "the agent's decisions with counterparties' names, amounts and reasons, and who decided a payment from Slack",
    when: "connected",
  },
  {
    name: "GitHub",
    privacyEntry: "GitHub",
    names: ["GitHub"],
    purpose: "answers whether a pull request is merged, and runs the GitHub App a workspace installs",
    data: "a pull request's owner, repository and number, and, for an installed app, a comment on the pull request a milestone was paid for",
    when: "always",
  },
  {
    name: "Xero",
    privacyEntry: "Xero",
    names: ["Xero"],
    purpose: "read for bills and suppliers, and written to only to book a payment a person approved",
    data: "the requests that read the organisation's bills and suppliers, and each booking: the bill's id, the account's id, the day, the amount and the Arc transaction",
    when: "connected",
  },
  {
    name: "Intuit (QuickBooks Online)",
    privacyEntry: "QuickBooks Online",
    names: ["Intuit", "QuickBooks"],
    purpose: "read for open bills, vendors and bank accounts, and never written to",
    data: "only the requests that read the company's bills, vendors and bank accounts",
    when: "connected",
  },
  {
    name: "HubSpot",
    privacyEntry: "HubSpot",
    names: ["HubSpot"],
    purpose: "read for deals, companies and contacts, and written to only once an owner or admin allows it",
    data: "what was collected on each planned deal, what is still owed, the last receipt and a link to the deal in Vestiarion",
    when: "connected",
  },
  {
    name: "Pipedrive",
    privacyEntry: "Pipedrive",
    names: ["Pipedrive"],
    purpose: "read for deals, organizations and persons, and written to only once an owner or admin allows it",
    data: "what was collected on each planned deal, what is still owed, the last receipt and a link to the deal in Vestiarion",
    when: "connected",
  },
  {
    name: "Asana",
    privacyEntry: "Asana",
    names: ["Asana"],
    purpose: "read for the tasks linked to milestones, and written to only to make and delete their webhooks",
    data: "the requests that read linked tasks, the webhooks made on them, and the email addresses it asks about to tell whether one belongs to an Asana user",
    when: "connected",
  },
  {
    name: "Google",
    privacyEntry: "Google Analytics",
    names: ["Google Analytics", "Google sign-in"],
    purpose: "counts page views with Google Analytics, and signs people in where Google sign-in is turned on",
    data: "redacted page paths and which button started someone off; for Google sign-in, the sign-in itself",
    when: "configured",
  },
  {
    name: "Product Hunt",
    privacyEntry: "Product Hunt",
    names: ["Product Hunt"],
    purpose: "serves the badge image on three public pages",
    data: "the IP address and browser of whoever loads the image",
    when: "always",
  },
];

/** When a service receives anything, in words. */
export const WHEN_WORDS: Record<Subprocessor["when"], string> = {
  always: "",
  configured: "when this deployment configures it",
  connected: "once someone connects it",
};
