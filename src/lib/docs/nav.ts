import { OPERATIONS, type DocOperation } from "@/lib/api/openapi";
import { docsHref, slugOfPathname } from "./paths";

export { docsHref, slugOfPathname };

/**
 * The developer docs' navigation: the one list the sidebar, the pager, the
 * static pages, search, the Markdown views and `llms.txt` are all built from.
 * A page exists when it is here and its MDX file is in `content/docs`; the
 * content test checks both directions. The API reference pages are the
 * exception: they are generated from `OPERATIONS`, one per operation, in its
 * order, and need no MDX.
 *
 * This module imports the operations and their schemas, so client components
 * take the nav as a prop from the server and import `./paths` for URLs.
 */

export interface NavPage {
  /** `""` is `/docs`; `"get-started/quickstart"` is `/docs/get-started/quickstart`. */
  slug: string;
  title: string;
  description: string;
  /**
   * A small heading inside a long section, drawn in the sidebar above the first page of its run (docs redesign D2):
   * "Accounting" inside "Connect your tools". Only the sidebar reads it; the pager, search and the Markdown views go by
   * the page and its section.
   */
  group?: string;
}

export interface NavSection {
  title: string;
  pages: NavPage[];
  /** A long list the sidebar folds until it is opened or holds the page being read (docs clarity N2). */
  folded?: boolean;
}

/** An operation's description, cut to its first sentence: the reference page's summary line. */
function firstSentence(op: DocOperation): string {
  const paragraph = op.description.split(/\n\s*\n/)[0].trim();
  return /^.*?[.!?](?=\s|$)/s.exec(paragraph)?.[0] ?? paragraph;
}

/**
 * Grouped by what a reader is trying to do (docs clarity N1, docs redesign D2): start, pay bills, plan and report, get
 * paid, see how payments are controlled, connect the team's tools, then build. The long sections are split into short
 * runs under a `group`. Order is the learning order the pager follows. Every page keeps the address it had; only its
 * place changed.
 */
export const DOCS_NAV: NavSection[] = [
  {
    title: "Get started",
    pages: [
      { slug: "", title: "Overview", description: "What Vestiarion does, where a business starts, how payments are controlled, and where developers start." },
      { slug: "guides/try-it", title: "See your first decision", description: "Create a workspace, add a supplier and one of your bills, and read what the agent decided and why, before any money moves. No wallet needed." },
      { slug: "guides/workspace", title: "Find your way around a workspace", description: "The sections and their groups, folding the sidebar, the header's network, payments and agent status, and the command palette's shortcuts." },
      { slug: "guides/shadow-mode", title: "Run alongside how you pay today", description: "Shadow mode: keep paying your bills as you do; the agent decides on the same bills, you agree or disagree with each decision, and each payment you agree to is made in USDC on Arc testnet." },
      { slug: "guides/go-live", title: "Go live", description: "Create the workspace's wallets, fund them with USDC and take the agent live, on Arc testnet or on Arc mainnet." },
    ],
  },
  {
    title: "Pay bills",
    pages: [
      { slug: "guides/first-payment", group: "Pay", title: "Your first payment", description: "Add a counterparty and an invoice, run a cycle, and follow the payment to the explorer and the ledger." },
      { slug: "guides/pay-a-contractor", group: "Pay", title: "Pay a contractor for delivered work", description: "Add a milestone, verify the work by hand or by a merged pull request, and let the agent release the pay." },
      { slug: "guides/early-payment-offers", group: "Pay", title: "Pay early for a discount", description: "Offer a supplier payment today for a discount Vestiarion suggests from the reserve's yield, through a one-time link; if they accept, the agent pays the discounted amount the same day, after every check." },
      { slug: "guides/more-time", group: "Pay", title: "Ask a supplier for more time", description: "When a bill is held because the cash is not there, let the agent ask the supplier by email for more time, for the same amount; a supplier who agrees moves the due date, and the agent decides the bill again." },
      { slug: "guides/bank-payouts", group: "Pay", title: "Pay a vendor's bank account in Mexico", description: "Set the workspace up with BlindPay, add a vendor's CLABE, and pay its bills in pesos over SPEI from your USDC: a person sees what the vendor receives and approves every bank payout." },
      { slug: "guides/import-bills", group: "Add bills", title: "Import your bill list", description: "Import the bills you keep in a spreadsheet, in its own columns, dates, numbers and currency: see every row's fate before anything is added, and fix the rows that can't be." },
      { slug: "guides/email-invoices", group: "Add bills", title: "Add invoices by email", description: "Turn on a workspace address, forward suppliers' invoices to it, and add each one from Bills & receivables with one press; nothing arrives as a payable by itself." },
      { slug: "guides/where-a-payment-is", group: "Follow a payment", title: "Know where a payment is", description: "Follow each payment from the agent's decision to the payee's wallet and your books: its stages and their sources, an outcome not known yet, payments in flight on Treasury, and a receipt's status." },
      { slug: "guides/payment-exceptions", group: "Follow a payment", title: "When a payment does not settle", description: "The runbook for a payment slow to confirm, of unknown outcome, failed, cancelled or not sent: who acts, what Vestiarion already did, what to do next and where the trail is, and why nothing is ever paid twice." },
      { slug: "guides/supplier-status", group: "For the people you pay", title: "Show a supplier when it will be paid", description: "Send a vendor a link to its own bills: where each one stands, from received to paid, with each payment's transaction on Arc, and never why a bill is held." },
      { slug: "guides/get-paid", group: "For the people you pay", title: "Get paid as a freelancer", description: "For the person being paid: add your wallet address through the link a business sent, follow each step, and check the payment on Arc." },
    ],
  },
  {
    title: "Plan and report",
    pages: [
      { slug: "guides/payment-plan", title: "Plan the next two weeks of payments", description: "See which bill leaves on which day over the next 14 days, in the order your cash allows, with the balance after each and the discounts worth taking, then approve the days the plan would move." },
      { slug: "guides/cash-scenarios", title: "Plan for clients paying late", description: "Treasury's What if section: look 30, 60 or 90 days ahead, make receivables late or missing, change what bills cost, and see the first short day, the bills it touches and what the figure is built from." },
      { slug: "guides/projects", title: "Give each project its own budget", description: "Make a project with a budget in USDC, put its bills, milestones and deals in it, and let the agent set each bill's money aside before paying it, holding what the budget cannot cover for a person. An earmark in Vestiarion, never money locked on chain." },
      { slug: "guides/currencies", title: "Work in your own currency", description: "Each amount as written, where it came from and the rate it was converted at; totals in your reporting currency with the rates shown; the FX variance on a paid bill; and exchange rates tried in a cash scenario, saved as versions." },
      { slug: "guides/report", title: "Read your workspace report", description: "What the agent did with your real bills: what it paid and with what proof, what it stopped and why, how often a person stepped in, what it was worth, and sharing a live copy by a link." },
      { slug: "guides/accountants", title: "Work across clients as an accountant", description: "Invite your accountant with the accountant role: one console lists every workspace they are in and what needs attention across them, oldest first, with a month's hand-off to download and each workspace's usage and limits." },
    ],
  },
  {
    title: "Get paid",
    pages: [
      { slug: "guides/deals", title: "Turn a signed deal into a collection schedule", description: "Confirm a deal's schedule from a deposit, milestones, a retainer or your own lines, release each line as a receivable on its day, and change the deal later without rewriting what was invoiced or paid." },
      { slug: "guides/customer-portal", title: "Share a statement with a customer", description: "Send a customer a link to its own statement: it sees what it owes, pays on Arc, says it paid, promises a day or disputes an invoice, with no account or wallet, and you answer each from the Receivables tab." },
      { slug: "guides/collections", title: "Chase what customers owe", description: "The next step for each receivable from what the customer said, paid and was promised: wait, ask the account owner, remind in the right tone or escalate to finance, with the reminder previewed and each customer's own rules." },
      { slug: "guides/customer-discounts", title: "Get paid sooner when cash is short", description: "Let the agent offer customers a small discount, up to the most you set, to pay an open invoice within 5 days while bills are held for want of cash; a customer who accepts pays the lower amount through its pay link." },
      { slug: "guides/apply-payments", title: "Apply money received to invoices", description: "One payment for several invoices, part payments, a few cents lost to a fee: apply each payment received on Arc to the right invoices, with the agent's suggestions, keep the rest as credit, and undo a mistake." },
      { slug: "guides/commissions", title: "Pay commissions on money received", description: "Set what a sales partner or referrer earns on the money customers pay for your deals: a part payment earns its part, a payment undone comes off the next payout, and after a hold window one payable is paid by the agent, which the partner cannot approve." },
    ],
  },
  {
    title: "Trust and controls",
    pages: [
      { slug: "guides/controls", title: "How payments are controlled", description: "What the agent decides and what it may pay: the checks in code, the limits, the people who approve, how to stop it, and where money can move." },
      { slug: "guides/try-a-rule", title: "Try a limit before you change it", description: "Try a new payment limit, two-approvals figure or spending limit on the agent's past decisions, see which bills it would have held or let through, then apply it." },
      { slug: "guides/evidence", title: "Why a payment was paid", description: "One payment's evidence, link by link from the purchase order to the receipt: how each fact is known, the signatures checked in your browser, the download, and who can see it." },
      { slug: "guides/evidence-and-receipts", title: "Share the evidence pack and receipts", description: "For an insurer, an auditor or a payee: the payee lock's evidence pack for a period, what each insurer question is answered from, its PDF, CSV and signed JSON checked offline; and a payment's shared receipt, what the payee sees and its three checks, saved as a PDF, renewed or stopped." },
      { slug: "guides/audit-export", title: "Verify an audit export", description: "Download a workspace's signed ledger and check it with a standalone verifier." },
      { slug: "research/model-vs-policy", title: "When the model and the policy disagree", description: "Production decisions beside the written policy's answer to the same facts: where they differed, and where code refused the model." },
      { slug: "contracts", title: "Contracts on Arc", description: "The contracts Vestiarion deploys and the Circle contracts it calls, with their addresses." },
    ],
  },
  {
    title: "Connect your tools",
    pages: [
      { slug: "guides/integrations", group: "All tools", title: "Every integration at a glance", description: "What each connected tool brings in, what Vestiarion writes back to it and who allows that, how it stays current, and what none of them does: approve or pay." },
      { slug: "guides/xero", group: "Accounting", title: "Bring bills in from Xero", description: "Connect a Xero organisation: its approved bills come in for review on Bills & receivables, go through the same check as a bill list, and become payables only when you add them. Choose the account payments made on Arc will be booked to." },
      { slug: "guides/quickbooks", group: "Accounting", title: "Bring bills in from QuickBooks Online", description: "Connect a QuickBooks Online company: its open bills come in for review on Bills & receivables, go through the same check as a bill list, and become payables only when you add them. Choose the bank account payments made on Arc will be booked to." },
      { slug: "guides/zohobooks", group: "Accounting", title: "Bring bills in from Zoho Books", description: "Connect a Zoho Books organization, in whichever Zoho data center it lives: its open bills come in for review on Bills & receivables, go through the same check as a bill list, and become payables only when you add them. Nothing is written to Zoho Books." },
      { slug: "guides/hubspot", group: "Sales and CRM", title: "Bring deals in from HubSpot", description: "Connect a HubSpot account: its won deals come in with their customers under Deals on Bills & receivables, Plan collections fills in the New deal form, and a deal changed in HubSpot afterwards says so for you to act on." },
      { slug: "guides/pipedrive", group: "Sales and CRM", title: "Bring deals in from Pipedrive", description: "Connect a Pipedrive company: its won deals come in with their organizations under Deals on Bills & receivables, Plan collections fills in the New deal form, a deal changed in Pipedrive afterwards says so, and receipts from Arc mainnet go back to the deal once allowed." },
      { slug: "guides/zohocrm", group: "Sales and CRM", title: "Bring deals in from Zoho CRM", description: "Connect a Zoho CRM organization, in whichever Zoho data center it lives: its won deals come in with their accounts under Deals on Bills & receivables, Plan collections fills in the New deal form, and a deal changed in Zoho CRM afterwards says so. Nothing is written to Zoho CRM." },
      { slug: "guides/asana", group: "Delivered work", title: "Accept contractor work from Asana", description: "Connect Asana, link a milestone to the task its work is delivered in, write the criteria from the agreement, and accept the work once the task is completed. A task reopened or changed after acceptance, once read, is held for review before the payment is sent." },
      { slug: "guides/github", group: "Delivered work", title: "Show payments on GitHub", description: "Connect GitHub so a milestone paid for a pull request gets a comment on it, pull requests in private repositories verify, and a maintainer attaches a bounty with a comment." },
      { slug: "guides/slack", group: "Team chat", title: "Get the agent's decisions in Slack", description: "Connect a workspace to a Slack channel: the agent's decisions as it makes them, /vestiarion for what is safe to spend and waiting, and stopped payments decided from Slack when an owner allows it." },
      { slug: "guides/telegram", group: "Team chat", title: "Get the agent's decisions in Telegram", description: "Connect your own Telegram chat to a workspace: the agent's decisions as it makes them, what is safe to spend and waiting, and invoices sent to the bot." },
      { slug: "guides/discord", group: "Team chat", title: "Get bills waiting for approval in Discord", description: "Connect a Discord channel with a webhook: each bill the agent holds or flags for a person is posted there after the cycle, with a link to review it in Approvals that never approves anything." },
      { slug: "guides/invoice-capture", group: "Your browser", title: "Capture invoices from Chrome", description: "Install Vestiarion Invoice Capture, connect it to your workspace, capture an invoice you select or choose, check its fields and send it as a draft that an owner or admin adds as a bill on Bills & receivables. It never pays." },
    ],
  },
  {
    title: "Developers",
    pages: [
      { slug: "get-started/quickstart", group: "Start", title: "Developer quickstart", description: "Create a workspace API key and make your first requests." },
      { slug: "get-started/sdk", group: "Start", title: "TypeScript SDK", description: "A typed client for the API and its webhooks: every page, safe retries and signature checks." },
      { slug: "get-started/cli", group: "Start", title: "Command-line interface", description: "The vestiarion command: log in once, read records and the agent's decisions, add records after a confirmation, and verify exports and webhooks offline." },
      { slug: "get-started/authentication", group: "Start", title: "Authentication", description: "Workspace API keys: their format, scope, revocation and use." },
      { slug: "get-started/postman", group: "Start", title: "Use Vestiarion from Postman", description: "Import the Getting Started and API reference collections, set a read-only key, make a first call, then add records with a read-and-write key." },
      { slug: "guides/api-invoices", group: "Guides", title: "Add invoices from your own system", description: "Create a read-and-write API key, add a counterparty and an invoice through the API, confirm the address, and follow the agent's decision." },
      { slug: "guides/api-milestones", group: "Guides", title: "Pay for merged pull requests", description: "Add a contractor, a payee link and a milestone through the API, and the agent pays once the pull request is merged. With a GitHub Actions workflow." },
      { slug: "data-delivery", group: "Guides", title: "Data delivery methods", description: "REST pull or webhook push: how each delivers data, and when to use which." },
      { slug: "get-started/errors", group: "Conventions", title: "Errors", description: "The error codes, their HTTP statuses and the error body." },
      { slug: "get-started/pagination", group: "Conventions", title: "Pagination", description: "Page through collections with limit and an opaque cursor." },
      { slug: "get-started/limits", group: "Conventions", title: "Limits", description: "Page sizes, backing off on 429 and 503, and how fresh the data is." },
      { slug: "ai-integration", group: "AI agents", title: "AI integration", description: "Markdown views, llms.txt and the OpenAPI document, for coding agents." },
      { slug: "ai-integration/mcp", group: "AI agents", title: "MCP server", description: "Connect an AI agent to your workspace's records through MCP tools: every API read, and with a read-and-write key, adding counterparties, invoices, milestones and payee links." },
    ],
  },
  {
    title: "API reference",
    folded: true,
    pages: [
      { slug: "api", title: "Endpoint overview", description: "Every v1 endpoint, what it answers, and the conventions they share." },
      ...OPERATIONS.map((op) => ({ slug: `api/${op.id}`, title: op.summary, description: firstSentence(op) })),
    ],
  },
  {
    title: "Webhooks",
    folded: true,
    pages: [
      { slug: "webhooks", title: "Webhooks overview", description: "Signed webhooks that push each ledger entry to your endpoint." },
      { slug: "webhooks/payload", title: "Payload and headers", description: "The body and headers of every webhook delivery." },
      { slug: "webhooks/verify", title: "Verifying signatures", description: "Check a delivery's signature, and a ledger entry's Ed25519 signature." },
      { slug: "webhooks/retries", title: "Retries and disabling", description: "How a failed delivery is retried, and when an endpoint is disabled." },
      { slug: "webhooks/security", title: "Security", description: "Which endpoint URLs are accepted, how long deliveries are kept, and who sees them." },
      { slug: "webhooks/guarantees", title: "Delivery guarantees", description: "At-least-once and out-of-order delivery, and how a receiver handles both." },
    ],
  },
  {
    title: "Changelog",
    pages: [{ slug: "changelog", title: "Changelog", description: "Changes to the API and webhooks, newest first." }],
  },
];

/** The operations grouped by tag, tags in the order they first appear: the endpoint overview's tables. */
export function operationsByTag(): Array<{ tag: DocOperation["tag"]; operations: DocOperation[] }> {
  const groups = new Map<DocOperation["tag"], DocOperation[]>();
  for (const op of OPERATIONS) groups.set(op.tag, [...(groups.get(op.tag) ?? []), op]);
  return [...groups].map(([tag, operations]) => ({ tag, operations }));
}

/** Every page, in nav order. */
export function flatPages(): NavPage[] {
  return DOCS_NAV.flatMap((section) => section.pages);
}

/** The pages before and after `slug` in nav order, across sections. */
export function neighbours(slug: string): { prev?: NavPage; next?: NavPage } {
  const pages = flatPages();
  const index = pages.findIndex((page) => page.slug === slug);
  if (index < 0) return {};
  return { prev: pages[index - 1], next: pages[index + 1] };
}

/** The page at `slug` and the title of its section, or undefined when the nav has no such page. */
export function findPage(slug: string): { page: NavPage; section: string } | undefined {
  for (const section of DOCS_NAV) {
    const page = section.pages.find((candidate) => candidate.slug === slug);
    if (page) return { page, section: section.title };
  }
  return undefined;
}
