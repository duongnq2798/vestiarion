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
}

export interface NavSection {
  title: string;
  pages: NavPage[];
}

/** An operation's description, cut to its first sentence: the reference page's summary line. */
function firstSentence(op: DocOperation): string {
  const paragraph = op.description.split(/\n\s*\n/)[0].trim();
  return /^.*?[.!?](?=\s|$)/s.exec(paragraph)?.[0] ?? paragraph;
}

export const DOCS_NAV: NavSection[] = [
  {
    title: "Overview",
    pages: [
      { slug: "", title: "Overview", description: "What Vestiarion is, and what its API and webhooks give an integration." },
      { slug: "data-delivery", title: "Data delivery methods", description: "REST pull or webhook push: how each delivers data, and when to use which." },
      { slug: "contracts", title: "Contracts on Arc testnet", description: "The contracts Vestiarion deploys and the Circle contracts it calls, with their addresses on Arc testnet." },
    ],
  },
  {
    title: "Guides",
    pages: [
      { slug: "guides/try-it", title: "Try it in 5 minutes", description: "Sign in, load sample data, watch the agent decide, approve a payment and verify the signed ledger." },
      { slug: "guides/go-live", title: "Go live", description: "Create the workspace's wallets, fund them with USDC and take the agent live, on Arc testnet or on Arc mainnet." },
      { slug: "guides/shadow-mode", title: "Run alongside how you pay today", description: "Shadow mode: keep paying your bills as you do; the agent decides on the same bills, you agree or disagree with each decision, and each payment you agree to is made in USDC on Arc testnet." },
      { slug: "guides/first-payment", title: "Your first payment", description: "Add a counterparty and an invoice, run a cycle, and follow the payment to the explorer and the ledger." },
      { slug: "guides/pay-a-contractor", title: "Pay a contractor for delivered work", description: "Add a milestone, verify the work by hand or by a merged pull request, and let the agent release the pay." },
      { slug: "guides/get-paid", title: "Get paid as a freelancer", description: "For the person being paid: add your wallet address through the link a business sent, follow each step, and check the payment on Arc testnet." },
      { slug: "guides/telegram", title: "Get the agent's decisions in Telegram", description: "Connect your own Telegram chat to a workspace: the agent's decisions as it makes them, what is safe to spend and waiting, and invoices sent to the bot." },
      { slug: "guides/email-invoices", title: "Add invoices by email", description: "Turn on a workspace address, forward suppliers' invoices to it, and add each one from AP / AR with one press; nothing arrives as a payable by itself." },
      { slug: "guides/slack", title: "Get the agent's decisions in Slack", description: "Connect a workspace to a Slack channel: the agent's decisions as it makes them, /vestiarion for what is safe to spend and waiting, and stopped payments decided from Slack when an owner allows it." },
      { slug: "guides/api-invoices", title: "Add invoices from your own system", description: "Create a read-and-write API key, add a counterparty and an invoice through the API, confirm the address, and follow the agent's decision." },
      { slug: "guides/api-milestones", title: "Pay for merged pull requests", description: "Add a contractor, a payee link and a milestone through the API, and the agent pays once the pull request is merged. With a GitHub Actions workflow." },
      { slug: "guides/github", title: "Show payments on GitHub", description: "Connect GitHub so a milestone paid for a pull request gets a comment on it, pull requests in private repositories verify, and a maintainer attaches a bounty with a comment." },
      { slug: "guides/audit-export", title: "Verify an audit export", description: "Download a workspace's signed ledger and check it with a standalone verifier." },
    ],
  },
  {
    title: "Research",
    pages: [
      { slug: "research/model-vs-policy", title: "When the model and the policy disagree", description: "Production decisions beside the written policy's answer to the same facts: where they differed, and where code refused the model." },
    ],
  },
  {
    title: "Get started",
    pages: [
      { slug: "get-started/quickstart", title: "Quickstart", description: "Create a workspace API key and make your first requests." },
      { slug: "get-started/sdk", title: "TypeScript SDK", description: "A typed client for the API and its webhooks: every page, safe retries and signature checks." },
      { slug: "get-started/authentication", title: "Authentication", description: "Workspace API keys: their format, scope, revocation and use." },
      { slug: "get-started/errors", title: "Errors", description: "The error codes, their HTTP statuses and the error body." },
      { slug: "get-started/pagination", title: "Pagination", description: "Page through collections with limit and an opaque cursor." },
      { slug: "get-started/limits", title: "Limits", description: "Page sizes, backing off on 429 and 503, and how fresh the data is." },
    ],
  },
  {
    title: "API reference",
    pages: [
      { slug: "api", title: "Endpoint overview", description: "Every v1 endpoint, what it answers, and the conventions they share." },
      ...OPERATIONS.map((op) => ({ slug: `api/${op.id}`, title: op.summary, description: firstSentence(op) })),
    ],
  },
  {
    title: "Webhooks",
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
    title: "AI integration",
    pages: [
      { slug: "ai-integration", title: "AI integration", description: "Markdown views, llms.txt and the OpenAPI document, for coding agents." },
      { slug: "ai-integration/mcp", title: "MCP server", description: "Connect an AI agent to your workspace's records through MCP tools: every API read, and with a read-and-write key, adding counterparties, invoices, milestones and payee links." },
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
