import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BENEFITS, BuildOnIt, DEVELOPER_DOCS } from "@/components/landing/BuildOnIt";
import { Claims } from "@/components/landing/Claims";
import { CodeShowcase } from "@/components/landing/build/CodeShowcase";
import { highlight } from "@/components/landing/build/highlight";
import { SNIPPETS } from "@/components/landing/build/snippets";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { OPERATIONS } from "@/lib/api/openapi";
import { GITHUB_URL } from "@/lib/site-links";

/**
 * For developers (docs/superpowers/specs/2026-10-18-landing-developers-design.md): the real snippet for the API, the
 * SDK and MCP, each held here to the docs and the API it comes from, highlighted without changing a character, and
 * copied exactly as shown.
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const docs = (slug: string) => readFileSync(path.join(process.cwd(), "content", "docs", `${slug}.mdx`), "utf8");
const snippet = (id: "api" | "sdk" | "mcp") => SNIPPETS.find((entry) => entry.id === id)!;
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

describe("highlight", () => {
  it("puts every line of every snippet back together exactly", () => {
    for (const entry of SNIPPETS) {
      const lines = highlight(entry.code, entry.lang);
      expect(lines.map((line) => line.map((token) => token.text).join("")).join("\n"), entry.id).toBe(entry.code);
    }
  });

  it("reads a shell line: the command, its flags, strings, variables and a comment", () => {
    const [comment, request] = highlight('# held\ncurl -H "Authorization: Bearer $KEY" $URL \\', "bash");
    expect(comment).toEqual([{ kind: "comment", text: "# held" }]);
    expect(request.filter((token) => token.kind !== "plain")).toEqual([
      { kind: "command", text: "curl" },
      { kind: "flag", text: "-H" },
      { kind: "string", text: '"Authorization: Bearer $KEY"' },
      { kind: "variable", text: "$URL" },
      { kind: "punctuation", text: "\\" },
    ]);
  });

  it("reads TypeScript's keywords, calls, keys and comments, and JSON's keys apart from its values", () => {
    const [line] = highlight("const x = await client.ledger.verify({ limit: 5 }); // done", "ts");
    expect(line.filter((token) => token.kind === "keyword").map((token) => token.text)).toEqual(["const", "await"]);
    expect(line.find((token) => token.kind === "command")?.text).toBe("verify");
    expect(line.find((token) => token.kind === "property")?.text).toBe("limit");
    expect(line.at(-1)).toEqual({ kind: "comment", text: "// done" });
    const [pair] = highlight('  "type": "http",', "json");
    expect(pair.filter((token) => token.kind === "property" || token.kind === "string")).toEqual([
      { kind: "property", text: '"type"' },
      { kind: "string", text: '"http"' },
    ]);
  });
});

describe("the snippets", () => {
  it("are the API, the SDK and MCP, in that order", () => {
    expect(SNIPPETS.map((entry) => entry.tab)).toEqual(["API", "SDK", "MCP"]);
  });

  it("call only operations the API has, with parameters it takes", () => {
    const calls = [...snippet("api").code.matchAll(/curl "?https:\/\/www\.vestiarion\.xyz(\/api\/v1\/[\w/]+)(\?[^"\s]*)?/g)];
    expect(calls.map((call) => call[1])).toEqual(["/api/v1/invoices", "/api/v1/treasury"]);
    for (const [, route, query] of calls) {
      const operation = OPERATIONS.find((op) => op.method === "get" && op.path === route);
      expect(operation, route).toBeDefined();
      for (const [name, value] of new URLSearchParams(query ?? "")) {
        const param = operation!.params.find((candidate) => candidate.name === name);
        expect(param, `${route} ${name}`).toBeDefined();
        if (param?.enum) expect(param.enum).toContain(value);
      }
    }
    // The reads need only a read-only key; the note says what a write needs, and that the API never pays.
    for (const route of ["/api/v1/invoices", "/api/v1/treasury"]) expect(OPERATIONS.find((op) => op.method === "get" && op.path === route)?.scope).toBe("read");
    expect(snippet("api").note).toContain("the API never approves or pays.");
    expect(OPERATIONS.find((op) => op.id === "create-invoice")?.description).toContain("The API never approves or pays.");
  });

  it("use the SDK as its guide does: the package, the client and each method", () => {
    const guide = docs("get-started/sdk");
    const code = snippet("sdk").code;
    expect(code.startsWith('import { Vestiarion } from "@vestiarion/sdk";')).toBe(true);
    expect(guide).toContain('import { Vestiarion } from "@vestiarion/sdk";');
    expect(guide).toContain("new Vestiarion({ apiKey: process.env.VESTIARION_API_KEY! })");
    expect(code).toContain("new Vestiarion({ apiKey: process.env.VESTIARION_API_KEY! })");
    for (const method of ["vestiarion.invoices.create(", "vestiarion.ledger.verify()"]) {
      expect(code).toContain(method);
      expect(guide).toContain(method);
    }
    expect(guide).toContain('{ counterpartyId: counterparty.id, amount: "420.00", dueDate: "2026-10-31", poReference: "PO-4012", goodsReceived: true }');
    expect(guide).toContain('{ idempotencyKey: "billing-inv-2026-0042" }');
    expect(code).toContain('{ idempotencyKey: "billing-inv-2026-0042" }');
  });

  it("configure MCP exactly as its guide's .mcp.json does", () => {
    const code = snippet("mcp").code;
    expect(docs("ai-integration/mcp")).toContain(code);
    expect(JSON.parse(code).mcpServers.vestiarion).toEqual({
      type: "http",
      url: "https://www.vestiarion.xyz/api/mcp",
      headers: { Authorization: "Bearer ${VESTIARION_API_KEY}" },
    });
    expect(docs("ai-integration/mcp")).toContain("no tool approves or pays");
  });

  it("hold no key: only the environment variable a reader sets", () => {
    for (const entry of SNIPPETS) {
      expect(entry.code, entry.id).not.toMatch(/vxk_/);
      for (const bearer of entry.code.matchAll(/Bearer ([^"\s]+)/g)) expect(["$VESTIARION_API_KEY", "${VESTIARION_API_KEY}"]).toContain(bearer[1]);
    }
  });

  it("lead to guides that exist, and to the package where it is published", () => {
    for (const entry of SNIPPETS) {
      for (const link of entry.links) {
        if (link.href.startsWith("https://")) {
          expect(link.href).toBe("https://www.npmjs.com/package/@vestiarion/sdk");
          continue;
        }
        const slug = link.href.replace(/^\/docs\/?/, "");
        expect(existsSync(path.join(process.cwd(), "content", "docs", `${slug}.mdx`)), link.href).toBe(true);
      }
    }
  });
});

describe("the code showcase", () => {
  const markup = render(<CodeShowcase />);

  it("is a set of tabs named for screen readers, opening on the API", () => {
    expect(markup).toMatch(/role="tablist"[^>]*aria-label="Ways to build on Vestiarion"|aria-label="Ways to build on Vestiarion"[^>]*role="tablist"/);
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:<[^>]+>)*API</);
    expect(markup).toContain('role="tabpanel"');
    expect(text(markup)).toContain('curl "https://www.vestiarion.xyz/api/v1/invoices?status=held&limit=5"');
  });

  it("shows the code as it is, scrolling inside the panel, with a copy button named for its tab", () => {
    expect(markup).toMatch(/<pre tabindex="0" aria-label="API example"[^>]*overflow-x-auto/);
    expect(markup).toContain('aria-label="Copy the API example"');
    expect(markup).toContain(">Copy<");
    // Nothing is typed out or replayed.
    expect(markup).not.toMatch(/Replay|terminal-caret/);
  });
});

describe("BuildOnIt", () => {
  const markup = render(<BuildOnIt />);
  const words = text(markup);

  it("keeps its heading and says who it is for, apart from the integrations above", () => {
    for (const part of [
      "For developers",
      "Runs where you already work.",
      "For builders: connect your own applications through the REST API, the TypeScript SDK or the MCP server",
    ]) {
      expect(words).toContain(part);
    }
    expect(BENEFITS.map((benefit) => benefit.title)).toEqual(["Build on the API", "Controls still apply", "Every action on record"]);
    expect(words).toContain("No key, SDK call or MCP tool approves or pays.");
  });

  it("starts at the quickstart, with the code on GitHub beside it", () => {
    expect(DEVELOPER_DOCS).toBe("/docs/get-started/quickstart");
    expect(existsSync(path.join(process.cwd(), "content", "docs", "get-started", "quickstart.mdx"))).toBe(true);
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${DEVELOPER_DOCS}"[^>]*>Read developer docs`));
    expect(markup).toMatch(new RegExp(`<a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer"`));
    for (const href of ["/docs/webhooks", "/docs/get-started/cli", "/docs/guides/github"]) expect(markup).toContain(`href="${href}"`);
  });
});

describe("Claims", () => {
  it("has the four checks at its head, then the four claims", () => {
    const claims = text(renderToStaticMarkup(<Claims screeningMode="live" />));
    expect(claims.indexOf("Four claims you can check")).toBeLessThan(claims.indexOf("A model can recommend payment."));
    for (const part of ["Circle payment rail", "Counterparty screening", "Evidence chain", "Open source", "Screening changes authority, not history."]) {
      expect(claims).toContain(part);
    }
  });
});
