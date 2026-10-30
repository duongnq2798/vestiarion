import { readFileSync } from "node:fs";
import path from "node:path";
import { Icon } from "lucide-react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyButton } from "@/components/ui/CopyButton";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { AuditLedger } from "@/components/vx/AuditLedger";
import { AuditEntryFacts, AuditRow, AuditRowIcons, type AuditRowFacts } from "@/components/vx/AuditRow";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import { DetailsTable } from "@/components/vx/InsightsTable";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ledgerHead } from "@/lib/ledger";
import { auditPage, insightsHistory } from "./support/audit-insights-fixtures";
import { AuditLedgerBefore } from "./support/audit-ledger-before";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";
import { InsightsChartsBefore } from "./support/insights-charts-before";
import { fromPayload, inlineScriptBytes, rscPayload } from "./support/rsc-payload";

/**
 * What the Audit and Insights pages send. Measured on production on Oct 30, in a team workspace: Audit was 2.0 MB of
 * HTML for a page of about a hundred entries, Insights 1.13 MB, each about half React's payload (the inline scripts it
 * hydrates the page from, which repeat every element the server drew) and half markup, much of it inside rows and
 * tables a person has not opened. Here each page's heavy part is drawn from fixtures at production's sizes, as HTML and
 * as the payload React's own renderer makes of it, and held under a bound so it cannot grow back unnoticed. What a
 * person sees, opens and hovers is held to what the same parts drew before (frozen in `tests/support/*-before.tsx`):
 * the closed rows, the opened rows read back from the payload as the browser reads it, every chart's marks and words.
 */

const bytes = (text: string) => Buffer.byteLength(text);
const html = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const sent = (page: { html: string; payload: string }) => bytes(page.html) + inlineScriptBytes(page.payload);

const ENTRIES = auditPage();
const AUDIT = { html: html(<AuditLedger entries={ENTRIES} />), payload: await rscPayload(<AuditLedger entries={ENTRIES} />, { AuditRow, AuditRowIcons }) };
const AUDIT_BEFORE = {
  html: html(<AuditLedgerBefore entries={ENTRIES} />),
  payload: await rscPayload(<AuditLedgerBefore entries={ENTRIES} />, { CopyButton, Icon }),
};

const DATA = insightsHistory();
const INSIGHTS = { html: renderToStaticMarkup(<InsightsCharts data={DATA} />), payload: await rscPayload(<InsightsCharts data={DATA} />, { DetailsTable }) };
const INSIGHTS_BEFORE = {
  html: renderToStaticMarkup(<InsightsChartsBefore data={DATA} />),
  payload: await rscPayload(<InsightsChartsBefore data={DATA} />, { Icon }),
};

describe("the audit log: a page of a hundred entries", () => {
  it("is under 230,000 bytes of HTML (201,000 now, 945,000 before)", () => {
    expect(bytes(AUDIT.html)).toBeLessThan(230_000);
  });

  it("sends under 230,000 bytes of payload in its inline scripts (199,000 now, 829,000 before)", () => {
    expect(inlineScriptBytes(AUDIT.payload)).toBeLessThan(230_000);
  });

  it("sends under a quarter of what it sent, markup and payload together", () => {
    expect(sent(AUDIT)).toBeLessThan(sent(AUDIT_BEFORE) / 4);
  });

  it("sends no entry's detail as markup, and each only once, as data", () => {
    expect(AUDIT.html).not.toContain("<pre");
    expect(AUDIT_BEFORE.html.match(/<pre/g)).toHaveLength(ENTRIES.length);
    for (const entry of ENTRIES) expect(AUDIT.payload.split(`"bodyHash":"${entry.bodyHash}"`)).toHaveLength(2);
  });
});

/** The ledger's closed rows, with each row's icons and its unopened facts set aside: they are compared on their own. */
function closed(markup: string): string {
  return markup
    .replace(/<svg aria-hidden="true" class="hidden">[\s\S]*?<\/defs><\/svg>/, "")
    .replace(/(<div class="space-y-3 pb-4 [^"]*">)[\s\S]*?(<\/div><\/details>)/g, "$1$2")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/g, "<svg/>");
}

const summaries = (markup: string) => [...markup.matchAll(/<summary[\s\S]*?<\/summary>/g)].map(([summary]) => summary);
const contents = (markup: string) => [...markup.matchAll(/<div class="space-y-3 pb-4 [^"]*">([\s\S]*?)<\/div><\/details>/g)].map(([, content]) => content);

/** A row as it is once opened, in a frame that says which it is. */
function Opened({ row }: { row: AuditRowFacts }) {
  return (
    <section data-opened={row.seq}>
      <AuditEntryFacts row={row} />
    </section>
  );
}

describe("the audit log reads and opens as it did", () => {
  it("draws its closed rows as before, word for word and class for class, but for where their icons are drawn", () => {
    expect(summaries(AUDIT.html)).toHaveLength(ENTRIES.length);
    expect(closed(AUDIT.html)).toBe(closed(AUDIT_BEFORE.html));
  });

  it("draws each row's domain glyph and chevron from the sheet, the same drawings in the same frames", () => {
    const symbols = new Map([...AUDIT.html.matchAll(/<symbol id="([^"]+)" viewBox="[^"]+">([\s\S]*?)<\/symbol>/g)].map(([, id, drawing]) => [id, drawing]));
    const before = summaries(AUDIT_BEFORE.html).map((summary) => summary.match(/<svg[^>]*>[\s\S]*?<\/svg>/g)!);
    summaries(AUDIT.html).forEach((summary, index) => {
      const [glyph, chevron] = summary.match(/<svg[^>]*>[\s\S]*?<\/svg>/g)!;
      const [glyphBefore, chevronBefore] = before[index];
      // The glyph: its frame as before, its drawing the one the row drew itself.
      expect(glyph.match(/^<svg[^>]*>/)![0]).toBe(glyphBefore.match(/^<svg[^>]*>/)![0]);
      expect(symbols.get(glyph.match(/<use href="#([^"]+)">/)![1])).toBe(glyphBefore.replace(/^<svg[^>]*>|<\/svg>$/g, ""));
      // The chevron: lucide's drawing in the sheet, sized, coloured and turned on opening by the same classes.
      const turned = chevron.match(/class="([^"]+)"/)![1];
      expect(chevronBefore).toContain(`class="lucide lucide-chevron-right ${turned}"`);
      expect(symbols.get(chevron.match(/<use href="#([^"]+)">/)![1])).toBe(chevronBefore.replace(` ${turned}`, ""));
    });
  });

  it("opens each row to the same facts and detail, drawn from the data the page sends, read back as the browser reads it", async () => {
    const opened = await fromPayload(AUDIT.payload, { AuditRow: Opened, AuditRowIcons: () => null }, html);
    const after = [...opened.matchAll(/<section data-opened="\d+">([\s\S]*?)<\/section>/g)].map(([, content]) => content);
    expect(after).toHaveLength(ENTRIES.length);
    expect(after).toEqual(contents(AUDIT_BEFORE.html));
  });

  it("is drawn from its payload as the server draws it", async () => {
    expect(await fromPayload(AUDIT.payload, { AuditRow, AuditRowIcons }, html)).toBe(AUDIT.html);
  });
});

describe("Insights, with the longest history its reads return (120 cycles, transfers and moves, 500 checks)", () => {
  it("is under 400,000 bytes of HTML (358,000 now, 941,000 before)", () => {
    expect(bytes(INSIGHTS.html)).toBeLessThan(400_000);
  });

  it("sends under 480,000 bytes of payload in its inline scripts (435,000 now, 1,409,000 before)", () => {
    expect(inlineScriptBytes(INSIGHTS.payload)).toBeLessThan(480_000);
  });

  it("sends under two fifths of what it sent, markup and payload together", () => {
    expect(sent(INSIGHTS)).toBeLessThan((sent(INSIGHTS_BEFORE) * 2) / 5);
  });

  it("sends each table's readings as values, and styles a cell once for the whole table", () => {
    expect(INSIGHTS.html).not.toMatch(/<td class=/);
    expect(INSIGHTS_BEFORE.html.match(/<td class="align-middle whitespace-nowrap px-2 py-2 tabular-nums text-ink-2">/g)!.length).toBe(INSIGHTS_BEFORE.html.match(/<td/g)!.length);
    for (const table of INSIGHTS.html.match(/<table class="[^"]*"/g)!) {
      for (const style of ["whitespace-nowrap", "px-2", "py-2", "align-middle", "tabular-nums", "text-ink-2"]) expect(table).toContain(`[&amp;_td]:${style}`);
    }
  });
});

/** Every mark a chart draws, as it is painted: its kind, its place to the thousandth of a unit and the paint it inherits. */
function marks(markup: string, kind: "circle" | "line" | "text") {
  const INHERITED = ["fill", "stroke", "stroke-width", "stroke-dasharray", "text-anchor", "font-size"];
  const stack: Array<Record<string, string>> = [];
  const found: string[] = [];
  const place = (value: string) => (/^-?\d+(\.\d+)?(e-?\d+)?$/.test(value) ? String(Math.round(Number(value) * 1000) / 1000) : value);
  for (const match of markup.matchAll(/<(\/?)([a-z]+)([^>]*)>/g)) {
    const [tag, closing, name, attributes] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const own = Object.fromEntries([...attributes.matchAll(/([a-z-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    if (name === kind) {
      const paint: Record<string, string> = Object.assign({}, ...stack.map((attrs) => Object.fromEntries(INHERITED.filter((key) => key in attrs).map((key) => [key, attrs[key]]))), own);
      // A dot's hover title, or a label's words.
      const next = markup.slice(match.index + tag.length);
      const words = kind === "circle" ? (next.match(/^<title>([^<]*)<\/title>/)?.[1] ?? "") : next.match(/^[^<]*/)![0];
      found.push(JSON.stringify([Object.entries(paint).map(([key, value]) => `${key}=${place(value)}`).sort(), words]));
    }
    if (!attributes.endsWith("/")) stack.push(own);
  }
  return found;
}

/** The charts with their marks and their tables' styles set aside: compared on their own. */
function charts(markup: string): string {
  return markup
    .replace(/<circle[^>]*>(<title>[^<]*<\/title>)?<\/circle>|<line[^>]*><\/line>|<text[^>]*>[^<]*<\/text>/g, "")
    .replace(/<\/?g[^>]*>/g, "")
    .replace(/<(table|td)( class="[^"]*")?/g, "<$1");
}

const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const titles = (markup: string) => [...markup.matchAll(/ title="([^"]*)"/g)].map(([, title]) => title);

describe("Insights reads as it did", () => {
  it("says the same words and numbers, every table cell and hover title included", () => {
    expect(textOf(INSIGHTS.html)).toBe(textOf(INSIGHTS_BEFORE.html));
    expect(titles(INSIGHTS.html)).toEqual(titles(INSIGHTS_BEFORE.html));
  });

  it("paints every dot, line and label where it was, in the same paint, each kind in the same order", () => {
    for (const kind of ["circle", "line", "text"] as const) {
      const after = marks(INSIGHTS.html, kind);
      expect(after.length, kind).toBeGreaterThan(0);
      expect(after, kind).toEqual(marks(INSIGHTS_BEFORE.html, kind));
    }
  });

  it("draws everything else exactly as before", () => {
    expect(charts(INSIGHTS.html)).toBe(charts(INSIGHTS_BEFORE.html));
  });

  it("is drawn from its payload as the server draws it", async () => {
    expect(await fromPayload(INSIGHTS.payload, { DetailsTable }, renderToStaticMarkup)).toBe(INSIGHTS.html);
  });
});

describe("the pages' reads", () => {
  const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0c";
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const page = (name: string) => readFileSync(path.join(process.cwd(), `src/app/o/[slug]/${name}/page.tsx`), "utf8").replace(/\s+/g, " ");
  /** `stats()` imported: every paid bill and two exact counts, for a header that shows the clock. */
  const STATS = /import \{[^}]*\bstats\b[^}]*\} from "@\/lib\/queries"/;

  it("ledgerHead reads the newest entry's number and hash, and nothing else of it", async () => {
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/ledger_entries" ? { body: [{ seq: 4300, hash: "ab".repeat(32) }] } : { body: [] }));
    const head = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => ledgerHead());
    expect(head).toEqual({ seq: 4300, hash: "ab".repeat(32) });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].params.get("select")).toBe("seq,hash");
    expect(fake.requests[0].params.get("order")).toBe("seq.desc");
    expect(fake.requests[0].params.get("limit")).toBe("1");
  });

  it("ledgerHead says so when the chain is empty", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    await expect(runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => ledgerHead())).resolves.toBeNull();
  });

  it("Audit reads the head only where its page does not start with it, and the header's clock alone", () => {
    const audit = page("audit");
    expect(audit).toContain("const newest = before === undefined && !domain;");
    expect(audit).toContain("newest ? Promise.resolve(null) : ledgerHead(),");
    expect(audit).toContain("const head = newest ? entries[0] : readHead;");
    expect(audit).not.toContain("listLedgerEntries(");
    expect(audit).toMatch(/await Promise\.all\(\[ listLedgerEntryPage\([^)]*\), newest \? Promise\.resolve\(null\) : ledgerHead\(\), ledgerEntryCount\(\), shellClock\(\), shellStatus\(\), \]\)/);
    expect(audit).not.toMatch(STATS);
  });

  it("Insights reads the header's clock alone, with its other reads", () => {
    const insights = page("insights");
    expect(insights).toMatch(/await Promise\.all\(\[ getInsightsData\(\), shellClock\(\), [^\]]*shellStatus\(\), \]\)/);
    expect(insights).not.toMatch(STATS);
  });
});
