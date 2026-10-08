import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildOnIt } from "@/components/landing/BuildOnIt";
import { Claims } from "@/components/landing/Claims";
import { frameAt, PAUSE, SNIPPETS, snippetCost, type SnippetLine } from "@/components/landing/build/snippets";
import { Terminal } from "@/components/landing/build/Terminal";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * "Build on it" (docs/superpowers/specs/2026-10-08-landing-motion-design.md M3): each way in typed into a terminal
 * from its guide's own snippet, the whole snippet always there for a screen reader and the server's HTML.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const LINES: SnippetLine[] = [
  { kind: "command", text: "npm i", typed: true },
  { kind: "output", text: "done", typed: false },
  { kind: "code", text: "go()", typed: true },
];

describe("frameAt", () => {
  it("types the first line, with the caret where the typing is", () => {
    expect(frameAt(LINES, 3)).toEqual([
      { text: "npm", shown: true, caret: true },
      { text: "", shown: false, caret: false },
      { text: "", shown: false, caret: false },
    ]);
  });

  it("shows a line that is not typed whole, after a pause, and types on", () => {
    expect(frameAt(LINES, 5 + PAUSE - 1)[1]).toEqual({ text: "", shown: false, caret: true });
    expect(frameAt(LINES, 5 + PAUSE + 2)).toEqual([
      { text: "npm i", shown: true, caret: false },
      { text: "done", shown: true, caret: false },
      { text: "go", shown: true, caret: true },
    ]);
  });

  it("shows everything, with no caret, once the whole cost is spent", () => {
    expect(frameAt(LINES, snippetCost(LINES))).toEqual(LINES.map((line) => ({ text: line.text, shown: true, caret: false })));
    expect(frameAt(LINES, Number.POSITIVE_INFINITY).every((frame) => frame.shown && !frame.caret)).toBe(true);
  });
});

describe("the snippets", () => {
  it("come from guides that exist", () => {
    for (const snippet of SNIPPETS) {
      const file = path.join(process.cwd(), "content", `${snippet.guide.href}.mdx`);
      expect(existsSync(file), snippet.guide.href).toBe(true);
    }
  });

  it("copy their own command or code, never what it answers", () => {
    const api = SNIPPETS.find((snippet) => snippet.id === "api")!;
    expect(api.copy.startsWith("curl https://www.vestiarion.xyz/api/v1/invoices")).toBe(true);
    expect(api.copy).not.toContain("201");
    expect(SNIPPETS.find((snippet) => snippet.id === "github")!.copy).toBe("/bounty 25");
  });
});

describe("Terminal", () => {
  it("renders the whole snippet on the server, the drawing hidden from assistive technology", () => {
    const snippet = SNIPPETS.find((item) => item.id === "mcp")!;
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <Terminal snippet={snippet} />
      </TooltipProvider>
    );
    expect(markup).toMatch(/<pre class="sr-only">claude mcp add --transport http vestiarion/);
    expect(markup).toMatch(/<pre aria-hidden="true"/);
    expect(text(markup)).toContain("Is our ledger intact, and are any payments held? Why was each one held?");
    expect(markup).toContain('href="/docs/ai-integration/mcp"');
  });
});

describe("BuildOnIt", () => {
  it("offers every way in, and opens on the API", () => {
    const words = text(renderToStaticMarkup(
        <TooltipProvider>
          <BuildOnIt />
        </TooltipProvider>
      ));
    for (const part of ["Build on it", "Runs where you already work.", "API", "SDK", "MCP", "GitHub", "curl https://www.vestiarion.xyz/api/v1/invoices"]) {
      expect(words).toContain(part);
    }
  });
});

describe("Claims", () => {
  it("has the four checks at its head, then the four claims", () => {
    const words = text(renderToStaticMarkup(<Claims screeningMode="live" />));
    expect(words.indexOf("Four claims you can check")).toBeLessThan(words.indexOf("A model can recommend payment."));
    for (const part of ["Circle payment rail", "Counterparty screening", "Evidence chain", "Open source", "Screening changes authority, not history."]) {
      expect(words).toContain(part);
    }
  });
});

describe("the terminal's lines", () => {
  it("fit the frame at desktop width, so none wraps there", () => {
    for (const snippet of SNIPPETS) {
      for (const line of snippet.lines) {
        expect((line.kind === "command" ? `$ ${line.text}` : line.text).length, line.text).toBeLessThanOrEqual(76);
      }
    }
  });

  it("wrap under themselves on a narrow screen, never scrolling the frame sideways", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <Terminal snippet={SNIPPETS[0]} />
      </TooltipProvider>
    );
    expect(markup).not.toContain("overflow-x-auto");
    expect(markup).toContain("whitespace-pre-wrap break-words");
  });
});
