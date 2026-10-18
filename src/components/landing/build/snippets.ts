import type { Lang } from "./highlight";

/**
 * What the landing's code showcase shows (docs/superpowers/specs/2026-10-18-landing-developers-design.md): one snippet
 * for each way a developer builds on Vestiarion, each taken from its guide, so nothing here says more than the docs do.
 * The API's two reads are the quickstart's request shape with the reference's parameters; the SDK's calls are the SDK
 * guide's; the MCP configuration is the MCP guide's `.mcp.json` for Claude Code. The copy button copies `code` exactly:
 * a placeholder is an environment variable the reader sets, never a key.
 */

export interface Snippet {
  id: "api" | "sdk" | "mcp";
  tab: string;
  lang: Lang;
  /** What the code is and runs in, above it. */
  context: string;
  code: string;
  /** What to know about it, under it: never part of what is copied. */
  note: string;
  /** Where it comes from and goes further, then any other place to get it. */
  links: ReadonlyArray<{ href: string; label: string }>;
}

const API = `# What the agent held, and why: each invoice carries its reasoning.
curl "https://www.vestiarion.xyz/api/v1/invoices?status=held&limit=5" \\
  -H "Authorization: Bearer $VESTIARION_API_KEY"

# The treasury: accounts, reserve, obligations and the latest forecast.
curl https://www.vestiarion.xyz/api/v1/treasury \\
  -H "Authorization: Bearer $VESTIARION_API_KEY"`;

const SDK = `import { Vestiarion } from "@vestiarion/sdk";

const vestiarion = new Vestiarion({ apiKey: process.env.VESTIARION_API_KEY! });

// Add a bill. A retry with the same key never adds it twice.
const invoice = await vestiarion.invoices.create(
  { counterpartyId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", amount: "420.00", dueDate: "2026-10-31", poReference: "PO-4012", goodsReceived: true },
  { idempotencyKey: "billing-inv-2026-0042" }
);

// Every record is signed into the ledger: check the whole chain.
const { valid } = await vestiarion.ledger.verify();`;

const MCP = `{
  "mcpServers": {
    "vestiarion": {
      "type": "http",
      "url": "https://www.vestiarion.xyz/api/mcp",
      "headers": {
        "Authorization": "Bearer \${VESTIARION_API_KEY}"
      }
    }
  }
}`;

export const SNIPPETS: readonly Snippet[] = [
  {
    id: "api",
    tab: "API",
    lang: "bash",
    context: "bash · REST API",
    code: API,
    note: "A read-only key reads the whole workspace. Adding records needs a read-and-write key, and the API never approves or pays.",
    links: [
      { href: "/docs/get-started/quickstart", label: "Quickstart" },
      { href: "/docs/api", label: "API reference" },
    ],
  },
  {
    id: "sdk",
    tab: "SDK",
    lang: "ts",
    context: "TypeScript · @vestiarion/sdk",
    code: SDK,
    note: "Typed from the API's OpenAPI document, with no dependencies. The agent decides the bill with every guardrail, as one typed into the console.",
    links: [
      { href: "/docs/get-started/sdk", label: "SDK guide" },
      { href: "https://www.npmjs.com/package/@vestiarion/sdk", label: "@vestiarion/sdk on npm" },
    ],
  },
  {
    id: "mcp",
    tab: "MCP",
    lang: "json",
    context: "JSON · .mcp.json for Claude Code",
    code: MCP,
    note: "Then ask: “Is our ledger intact, and are any payments held? Why was each one held?” The tools add records at most: none approves or pays.",
    links: [{ href: "/docs/ai-integration/mcp", label: "Setup for Claude Code, Cursor and Codex" }],
  },
];
