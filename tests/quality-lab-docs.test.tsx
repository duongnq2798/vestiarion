import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useMDXComponents } from "../mdx-components";
import { QualityLabScore, QualityLabTable } from "@/components/docs/QualityLab";
import { PAGE_LOADERS } from "@/lib/docs/content";
import { mdxToMarkdown, pageMarkdown } from "@/lib/docs/markdown";
import { DOCS_NAV } from "@/lib/docs/nav";
import results from "@/lib/data/quality-lab.json";
import type { QualityLabResult } from "@/lib/quality-lab/judge";
import { QUALITY_LAB_GROUPS, QUALITY_LAB_SCENARIOS } from "@/lib/quality-lab/scenarios";
import { outcomeWords, rightWords, scoreWords, wrongPaymentWords } from "@/lib/quality-lab/words";

/**
 * The Quality Lab's docs page (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL8): registered after the
 * model-and-policy note, every group with its heading and its table, the figures rendered from the committed results on
 * the page and in its Markdown view alike, never typed, with the definitions, what it does not cover, how to run it, and
 * the scenario source on GitHub.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const SOURCE = readFileSync(path.join(process.cwd(), "content", "docs", "research", "quality-lab.mdx"), "utf8");
const MARKDOWN = pageMarkdown("research/quality-lab", ORIGIN) ?? "";
const SCENARIOS = results.scenarios as QualityLabResult[];

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("the Quality Lab's docs page (QL8)", () => {
  it("is in Trust and controls, after the model-and-policy note, with its loader", () => {
    const pages = DOCS_NAV.find((section) => section.title === "Trust and controls")!.pages.map((page) => page.slug);
    expect(pages.indexOf("research/quality-lab")).toBe(pages.indexOf("research/model-vs-policy") + 1);
    expect(Object.keys(PAGE_LOADERS)).toContain("research/quality-lab");
  });

  it("has every group's heading and table, in the groups' order", () => {
    const tables = [...SOURCE.matchAll(/<QualityLabTable group="([a-z]+)" \/>/g)].map((match) => match[1]);
    expect(tables).toEqual(QUALITY_LAB_GROUPS.map((group) => group.id));
    for (const group of QUALITY_LAB_GROUPS) {
      const heading = SOURCE.indexOf(`### ${group.title}\n`);
      expect(heading, group.title).toBeGreaterThan(-1);
      expect(SOURCE.indexOf(`<QualityLabTable group="${group.id}" />`)).toBeGreaterThan(heading);
    }
  });

  it("types no figure: the score comes from the results", () => {
    expect(SOURCE).toContain("<QualityLabScore />");
    expect(SOURCE).not.toMatch(/\d+ of \d+ scenarios/);
    expect(SOURCE).not.toMatch(/\d+ wrong payments?/);
  });

  it("states the definitions, what it does not cover, how to run it, and where the scenarios are", () => {
    for (const part of [
      "A scenario is **right** when money moved or stopped as expected, with the expected status and rule.",
      "A **wrong payment** is any transfer or schedule where money should stop, a transfer to an address other than the one on file or for an amount other than the bill's, or a second transfer for one bill.",
      "## What it does not cover",
      "npm run quality-lab",
      "https://github.com/duongnq2798/vestiarion/blob/main/src/lib/quality-lab/scenarios.ts",
      "Arc testnet",
      "Arc mainnet",
    ]) {
      expect(SOURCE, part).toContain(part);
    }
  });

  it("names every stand-in: the contract's answer on Arc is scripted, and the new payee facts are given", () => {
    expect(SOURCE).toContain(
      "The stand-ins are the database, the clock, the payment provider and the spending limit contract on Arc, whose answer the lab scripts"
    );
    expect(SOURCE).toContain("are given to the new payee check directly, not read from its past payments and ledger entries.");
    expect(SOURCE).not.toMatch(/Only the database, the clock and the payment provider are stand-ins/);
  });
});

/** Every page that describes the lab says no more than it does: answers often an attacker's, and USDC bills only. */
describe("the Quality Lab where other pages describe it (QL9)", () => {
  const controls = readFileSync(path.join(process.cwd(), "content", "docs", "guides", "controls.mdx"), "utf8");
  const line = controls.split("\n").find((row) => row.includes("(/docs/research/quality-lab)")) ?? "";

  it("says in the controls guide that it covers most of the checks, for USDC bills, with answers often an attacker's", () => {
    expect(line).toContain("runs fixed scenarios for USDC bills through most of these checks");
    expect(line).toContain("often as an attacker would want them");
  });
});

describe("the score and the tables, on the page (QL8)", () => {
  it("are what the MDX components render", () => {
    const components = useMDXComponents();
    expect(components.QualityLabScore).toBe(QualityLabScore);
    expect(components.QualityLabTable).toBe(QualityLabTable);
  });

  it("say the score and the wrong payments", () => {
    const score = renderToStaticMarkup(<QualityLabScore />);
    expect(score).toMatch(new RegExp(`^<p[^>]*><strong[^>]*>${scoreWords(results.summary)}</strong>, ${wrongPaymentWords(results.summary.wrongPayments)}\\.</p>$`));
  });

  it("list each scenario of a group with what was expected, what happened and whether it was right", () => {
    for (const group of QUALITY_LAB_GROUPS) {
      const markup = renderToStaticMarkup(<QualityLabTable group={group.id} />);
      const rows = [...markup.matchAll(/<tr>(.*?)<\/tr>/g)].slice(1).map((row) => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => text(cell[1])));
      const mine = SCENARIOS.filter((scenario) => scenario.group === group.id);
      expect(rows, group.id).toEqual(mine.map((scenario) => [scenario.title, outcomeWords(scenario.expected), outcomeWords(scenario.actual), rightWords(scenario)]));
    }
  });

  it("refuse a group with no scenarios, so a typo cannot render an empty table", () => {
    expect(() => renderToStaticMarkup(<QualityLabTable group="nope" />)).toThrow(/nope/);
  });
});

describe("the page's Markdown view (QL8)", () => {
  it("carries the same score and rows as the page", () => {
    expect(MARKDOWN).toContain(`**${scoreWords(results.summary)}**, ${wrongPaymentWords(results.summary.wrongPayments)}.`);
    for (const scenario of SCENARIOS) {
      expect(MARKDOWN, scenario.id).toContain(`| ${scenario.title} | ${outcomeWords(scenario.expected)} | ${outcomeWords(scenario.actual)} | ${rightWords(scenario)} |`);
    }
    expect(MARKDOWN).toContain("| Scenario | Expected | What happened | Right |");
  });

  it("writes a table that names no group as a refusal, as the page does", () => {
    expect(() => mdxToMarkdown('<QualityLabTable group="nope" />\n', ORIGIN)).toThrow(/nope/);
  });

  it("names every scenario in the source, and only those", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual(QUALITY_LAB_SCENARIOS.map((scenario) => scenario.id));
  });
});
