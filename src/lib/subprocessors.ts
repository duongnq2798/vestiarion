/**
 * The services that process data for Vestiarion, as the security page lists them. The privacy page says in full what
 * each one receives; `tests/security-page.test.tsx` holds the two pages to the same services, so a service named on
 * one and not the other fails there.
 */

import { ENS_GATEWAY_HOSTS, ENS_RPC_DEFAULT } from "./ens-hosts";
import { NETWORKS } from "./network";

/** The day this list was last checked against the code. */
export const SUBPROCESSORS_AS_OF = "2026-10-23";

const hostOf = (url: string) => new URL(url).host;

const PROFILES = Object.values(NETWORKS);

/** Arc's nodes the server reads from by default, from the network profiles; `ARC_RPC_URL` and `ARC_MAINNET_RPC_URL` add a node that takes some reads, while receipts stay on these. */
export const ARC_RPC_HOSTS: readonly string[] = PROFILES.map((profile) => hostOf(profile.rpcUrl));

/**
 * The other nodes the server reads from: those of the chains a payee is paid on, where a receipt of a payout is read
 * (`src/lib/receipts/onchain.ts`). The chains USDC can be brought from are handed to the person's wallet instead.
 */
/** Ethereum's node an address field looks names up on (ENS address names EN4), and the one gateway a Basename goes through. */
export const ENS_RPC_HOST = new URL(ENS_RPC_DEFAULT).hostname;
export { ENS_GATEWAY_HOSTS };

export const PAYEE_CHAIN_RPC_HOSTS: readonly string[] = PROFILES.flatMap((profile) => profile.payeeChains)
  .map((chain) => hostOf(chain.rpcUrl))
  .filter((host, index, hosts) => !ARC_RPC_HOSTS.includes(host) && hosts.indexOf(host) === index);

/** "a, b and c". */
export const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** When a service receives anything, in words: nothing for always, or the condition. */
export const ONLY_IF_CONFIGURED = "when this deployment configures it";
export const ONLY_IF_CONNECTED = "when someone connects it";

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
  /** When it receives anything, in words; empty when it always does. */
  when: string;
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Vercel",
    privacyEntry: "Vercel",
    names: ["Vercel"],
    purpose: "hosts the app and runs its server code",
    data: "every request to the app and its API, and the app's answers",
    when: "",
  },
  {
    name: "Supabase",
    privacyEntry: "Supabase",
    names: ["Supabase"],
    purpose: "holds the Postgres database, runs sign-in, and keeps the documents vendors send for a bill in private storage",
    data: "everything a workspace stores, the documents vendors send through a request's link, and each person's sign-in account",
    when: "",
  },
  {
    name: "Circle",
    privacyEntry: "Circle",
    names: ["Circle"],
    purpose: "creates the wallets and moves the payments, through Developer-Controlled Wallets, CCTP, Gateway, its Smart Contract Platform, its Stablecoin Service and Modular Wallets",
    data: "wallet addresses, payment amounts and signed x402 payments, and a passkey's public key for a passkey wallet",
    when: "",
  },
  {
    name: "Resend",
    privacyEntry: "Resend",
    names: ["Resend"],
    purpose: "sends transactional email, and receives the emails sent to a workspace's invoice address",
    data: "each recipient's email address and the message, and the emails that reach an invoice address",
    when: ONLY_IF_CONFIGURED,
  },
  {
    name: "Anthropic, OpenAI or DeepSeek",
    privacyEntry: "A model provider",
    names: ["Anthropic", "OpenAI", "DeepSeek"],
    purpose: "proposes the agent's decisions and reads invoices",
    data: "the facts of each decision the agent asks it about; for each email to a workspace's invoice address, its first PDF, .eml or .txt attachment, or else its text; each document a member has it read; and each plain-text message a linked member sends the Telegram bot",
    when: ONLY_IF_CONFIGURED,
  },
  {
    name: "OpenSanctions",
    privacyEntry: "OpenSanctions",
    names: ["OpenSanctions"],
    purpose: "screens counterparties against sanctions lists",
    data: "the names and jurisdictions of a live workspace's counterparties",
    when: ONLY_IF_CONFIGURED,
  },
  {
    name: "ExchangeRate-API",
    privacyEntry: "ExchangeRate-API",
    names: ["ExchangeRate-API"],
    purpose: "gives the day's rates against the US dollar",
    data: "nothing about you, your workspace or your bills",
    when: "",
  },
  {
    name: "RPC nodes",
    privacyEntry: "RPC nodes",
    names: ["RPC nodes", "PublicNode"],
    purpose: `answer the server's reads of balances, fees and receipts: Arc's node (${listed(ARC_RPC_HOSTS)}, and, where set, the ones ARC_RPC_URL and ARC_MAINNET_RPC_URL name, which take some reads, while receipts stay on the public node), and, for a receipt of a payout to another chain from Arc, ${listed(PAYEE_CHAIN_RPC_HOSTS)}, PublicNode's among them; and, to look up an ENS name or Basename typed into an address field, Ethereum's node at ${ENS_RPC_HOST} (or the one ENS_RPC_URL names) and, for a Basename, Coinbase's gateway at ${ENS_GATEWAY_HOSTS.join(" and ")}`,
    data: "the wallet addresses and transaction hashes read, which are already public on chain, and a name or address looked up",
    when: "",
  },
  {
    name: "Telegram",
    privacyEntry: "Telegram",
    names: ["Telegram"],
    purpose: "sends the bot's messages to a member who connects their chat",
    data: "the agent's decisions with counterparties' names, amounts and reasons, and the answers to the member's questions",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Slack",
    privacyEntry: "Slack",
    names: ["Slack"],
    purpose: "receives the posts and answers for a workspace connected to a Slack channel",
    data: "the agent's decisions with counterparties' names, amounts and reasons, who decided a payment from Slack, and the sender's email address of an email to the invoice address that names no vendor or cannot be read",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Discord",
    privacyEntry: "Discord",
    names: ["Discord"],
    purpose: "receives the posts for a workspace connected to a Discord channel",
    data: "the workspace's name and, for each bill held for a person, its counterparty's name, amount, the agent's reason and a link to review it",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "GitHub",
    privacyEntry: "GitHub",
    names: ["GitHub"],
    purpose: "answers whether a pull request is merged or can still be opened, and runs the GitHub App",
    data: "a pull request's owner, repository and number, and, for an installed app, a comment on the pull request a milestone was paid for",
    when: "only when a milestone or its evidence names a pull request, or a workspace installs the app",
  },
  {
    name: "Xero",
    privacyEntry: "Xero",
    names: ["Xero"],
    purpose: "read for bills and suppliers, and written to only to book a payment a person approved",
    data: "the requests that read the organisation's bills and suppliers, and each booking: the bill's id, the account's id, the day, the amount and the Arc transaction",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Intuit (QuickBooks Online)",
    privacyEntry: "QuickBooks Online",
    names: ["Intuit", "QuickBooks"],
    purpose: "read for open bills, vendors and bank accounts, and never written to",
    data: "only the requests that read the company's bills, vendors and bank accounts",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Zoho (Zoho Books and Zoho CRM)",
    privacyEntry: "Zoho Books and Zoho CRM",
    names: ["Zoho", "Zoho Books", "Zoho CRM"],
    purpose: "read for open bills and vendors in Zoho Books and for deals with their accounts and contacts in Zoho CRM, at the data center the account lives in, and never written to",
    data: "only the requests that read the Zoho Books organizations a person can reach and the bills and vendors of the one they pick, and the deals, accounts, contacts, deal pipelines and organization of the Zoho CRM organization connected",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "BlindPay",
    privacyEntry: "BlindPay",
    names: ["BlindPay"],
    purpose: "pays a vendor's bills to its bank account in Mexico, in pesos over SPEI, from the workspace's USDC",
    data: "the workspace's name and the owner's email, each vendor's CLABE and the name its account is held in, each payout's amount, and the operating wallet's address",
    when: "when an owner sets up bank payouts",
  },
  {
    name: "HubSpot",
    privacyEntry: "HubSpot",
    names: ["HubSpot"],
    purpose: "read for deals, companies and contacts, and written to only once an owner or admin allows it",
    data: "what was collected on each planned deal, what is still owed, the last receipt and a link to the deal in Vestiarion",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Pipedrive",
    privacyEntry: "Pipedrive",
    names: ["Pipedrive"],
    purpose: "read for deals, organizations and persons, and written to only once an owner or admin allows it",
    data: "what was collected on each planned deal, what is still owed, the last receipt and a link to the deal in Vestiarion",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Asana",
    privacyEntry: "Asana",
    names: ["Asana"],
    purpose: "read for the tasks linked to milestones, and written to only to make and delete their webhooks",
    data: "the requests that read linked tasks, the webhooks made on them, and the email addresses it asks about to tell whether one belongs to an Asana user",
    when: ONLY_IF_CONNECTED,
  },
  {
    name: "Google",
    privacyEntry: "Google Analytics",
    names: ["Google Analytics", "Google sign-in"],
    purpose:
      "counts page views with Google Analytics on every page, signed-in ones included, and signs people in where Google sign-in is turned on",
    data:
      "each page's redacted path, its title, with a workspace page's replaced by its redacted path, its redacted referrer, which button started someone off, and what Google Analytics collects itself, such as the IP address, its cookies and the device; for Google sign-in, the sign-in itself",
    when: ONLY_IF_CONFIGURED,
  },
  {
    name: "Product Hunt",
    privacyEntry: "Product Hunt",
    names: ["Product Hunt"],
    purpose: "serves the badge image on three public pages",
    data: "the IP address and browser of whoever loads the image",
    when: "",
  },
];

/** The terms each model provider handles API requests under, which the security and privacy pages link. */
export const MODEL_PROVIDER_TERMS = [
  { name: "Anthropic", href: "https://www.anthropic.com/legal/commercial-terms" },
  { name: "OpenAI", href: "https://openai.com/policies/services-agreement/" },
  { name: "DeepSeek", href: "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html" },
] as const;
