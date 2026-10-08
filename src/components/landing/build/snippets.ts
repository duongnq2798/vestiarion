/**
 * What the landing's "Build on it" terminal types (docs/superpowers/specs/2026-10-08-landing-motion-design.md M3): one
 * snippet per way in, each taken from its guide, so nothing here says more than the docs do. A `typed` line is typed
 * out character by character; any other line appears whole once the lines before it are done.
 */

export type LineKind = "command" | "code" | "output" | "note";

export interface SnippetLine {
  kind: LineKind;
  text: string;
  /** Typed out, rather than appearing whole. Commands and code are; output and notes are not. */
  typed: boolean;
}

export interface Snippet {
  id: "api" | "sdk" | "mcp" | "github";
  tab: string;
  /** What runs it, in the terminal's header. */
  context: string;
  lines: SnippetLine[];
  /** What the copy button copies: the snippet's own command or code, never its output. */
  copy: string;
  guide: { href: string; label: string };
}

const command = (text: string): SnippetLine => ({ kind: "command", text, typed: true });
const code = (text: string): SnippetLine => ({ kind: "code", text, typed: true });
const output = (text: string): SnippetLine => ({ kind: "output", text, typed: false });
const note = (text: string): SnippetLine => ({ kind: "note", text, typed: false });

const CURL = [
  "curl https://www.vestiarion.xyz/api/v1/invoices \\",
  "  -X POST \\",
  '  -H "Authorization: Bearer $VESTIARION_API_KEY" \\',
  '  -H "Content-Type: application/json" \\',
  '  -H "Idempotency-Key: billing-inv-2026-0042" \\',
  `  -d '{"counterpartyId":"7c9e6679-7425-40de-944b-e07fc1f90ae7",`,
  `       "amount":"420.00","dueDate":"2026-10-31",`,
  `       "poReference":"PO-4012","goodsReceived":true}'`,
];

const SDK = [
  'import { Vestiarion } from "@vestiarion/sdk";',
  "",
  "const vestiarion = new Vestiarion({",
  "  apiKey: process.env.VESTIARION_API_KEY!,",
  "});",
  "",
  "const invoice = await vestiarion.invoices.create(",
  '  { counterpartyId, amount: "420.00", dueDate: "2026-10-31",',
  '    poReference: "PO-4012", goodsReceived: true },',
  '  { idempotencyKey: "billing-inv-2026-0042" }',
  ");",
  "const verification = await vestiarion.ledger.verify();",
];

const MCP = [
  "claude mcp add --transport http vestiarion \\",
  "  https://www.vestiarion.xyz/api/mcp \\",
  '  --header "Authorization: Bearer $VESTIARION_API_KEY"',
];

export const SNIPPETS: readonly Snippet[] = [
  {
    id: "api",
    tab: "API",
    context: "bash · REST API",
    lines: [
      command(CURL[0]),
      ...CURL.slice(1).map(code),
      output("201 Created"),
      output('{ "status": "pending", "amount": "420.00", "dueDate": "2026-10-31", … }'),
      note("# The agent decides it as one typed into the console,"),
      note("# with every guardrail."),
    ],
    copy: CURL.join("\n"),
    guide: { href: "/docs/guides/api-invoices", label: "Send invoices from your system" },
  },
  {
    id: "sdk",
    tab: "SDK",
    context: "TypeScript · @vestiarion/sdk",
    lines: [command("npm install @vestiarion/sdk"), note(""), ...SDK.map(code)],
    copy: SDK.join("\n"),
    guide: { href: "/docs/get-started/sdk", label: "The typed client" },
  },
  {
    id: "mcp",
    tab: "MCP",
    context: "Claude Code · MCP server",
    lines: [
      command(MCP[0]),
      ...MCP.slice(1).map(code),
      note("# Then ask in plain language:"),
      output("> Is our ledger intact, and are any payments held? Why was each one held?"),
      note('# It calls verify_ledger, then list_invoices with status "held":'),
      note("# each held invoice carries the agent's reasoning."),
    ],
    copy: MCP.join("\n"),
    guide: { href: "/docs/ai-integration/mcp", label: "Connect an AI agent" },
  },
  {
    id: "github",
    tab: "GitHub",
    context: "GitHub · a comment on a pull request",
    lines: [
      note("# Anyone who can write to the repository comments, on a line of its own:"),
      code("/bounty 25"),
      note("# The app replies with the bounty, and asks the author where to be paid."),
      note("# Once it is merged, the agent pays them,"),
      note("# and the transaction is posted on the pull request."),
    ],
    copy: "/bounty 25",
    guide: { href: "/docs/guides/github", label: "Pay for merged pull requests" },
  },
];

/** A typed line costs its length; a line that appears whole costs a short pause before it does. */
export const PAUSE = 18;

export function lineCost(line: SnippetLine): number {
  return line.typed ? Math.max(1, line.text.length) : PAUSE;
}

export function snippetCost(lines: readonly SnippetLine[]): number {
  return lines.reduce((sum, line) => sum + lineCost(line), 0);
}

export interface LineFrame {
  /** What of the line shows now. */
  text: string;
  shown: boolean;
  /** The line being typed, where the caret is. */
  caret: boolean;
}

/** Each line as it stands once `budget` of the snippet's cost is spent: the typing so far, and every line it has passed. */
export function frameAt(lines: readonly SnippetLine[], budget: number): LineFrame[] {
  let left = budget;
  let caretPlaced = false;
  return lines.map((line) => {
    const cost = lineCost(line);
    if (left >= cost) {
      left -= cost;
      return { text: line.text, shown: true, caret: false };
    }
    const spent = Math.max(0, left);
    left = -1;
    if (caretPlaced) return { text: "", shown: false, caret: false };
    caretPlaced = true;
    return line.typed ? { text: line.text.slice(0, Math.floor(spent)), shown: true, caret: true } : { text: "", shown: false, caret: true };
  });
}
