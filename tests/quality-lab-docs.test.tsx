import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useMDXComponents } from "../mdx-components";
import { QualityLabScore, QualityLabTable, ShadowReplaySummary, ShadowReplayTable } from "@/components/docs/QualityLab";
import { PAGE_LOADERS } from "@/lib/docs/content";
import { mdxToMarkdown, pageMarkdown } from "@/lib/docs/markdown";
import { DOCS_NAV } from "@/lib/docs/nav";
import results from "@/lib/data/quality-lab.json";
import shadow from "@/lib/data/quality-lab-shadow.json";
import type { ShadowReplayResults } from "@/lib/quality-lab/shadow-replay";
import { SHADOW_NOTES_HEAD, SHADOW_TABLE_HEAD, shadowRows } from "@/lib/quality-lab/shadow-results";
import type { QualityLabResult } from "@/lib/quality-lab/judge";
import { QUALITY_LAB_GROUPS, QUALITY_LAB_SCENARIOS } from "@/lib/quality-lab/scenarios";
import { answerWords, outcomeWords, replayOutcomeWords, replayResultWords, rightWords, scoreWords, shadowReplayWords, verdictWords, wrongPaymentWords } from "@/lib/quality-lab/words";

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

  it("is described, under its title and in search, as both halves: the scenarios and the replayed shadow decisions", () => {
    const page = DOCS_NAV.flatMap((section) => section.pages).find((one) => one.slug === "research/quality-lab")!;
    expect(page.description).toContain("with the model's answers scripted");
    expect(page.description).toContain("the team's own shadow-mode decisions replayed through the same code with the model's answers as recorded");
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

/**
 * The three places that name the lab's stand-ins (QL1) name all four: the docs page, the harness's header and
 * ARCHITECTURE.md's Quality Lab section. A stand-in left out of one would read as code the lab runs for real.
 */
describe("the stand-ins, where they are named (QL1)", () => {
  const harness = readFileSync(path.join(process.cwd(), "tests", "support", "ap-harness.ts"), "utf8");
  const architecture = readFileSync(path.join(process.cwd(), "ARCHITECTURE.md"), "utf8");
  const section = architecture.slice(architecture.indexOf("## The Quality Lab\n"));
  const places = {
    "the docs page": SOURCE,
    "the harness's header": harness.slice(harness.indexOf("/**"), harness.indexOf("*/") + 2),
    "ARCHITECTURE.md's Quality Lab section": section.slice(0, section.indexOf("\n## ", 1)),
  };
  // Markdown and comments wrap anywhere, so any run of whitespace stands for a space.
  const standIns = {
    "the database": /the\s+database|`fakeSupabase`/,
    "the clock": /the\s+clock/,
    "the payment provider": /the\s+payment\s+provider|`LabChain`/,
    "the spending limit contract's answer on Arc": /spending\s+limit\s+contract('s\s+answer)?\s+on\s+Arc/,
  };

  it.each(Object.entries(places))("%s names every stand-in", (_place, words) => {
    expect(words.length).toBeGreaterThan(200);
    for (const [standIn, pattern] of Object.entries(standIns)) {
      expect(words, standIn).toMatch(pattern);
    }
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

/**
 * The replay of the team's shadow-mode decisions on the same page
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR11): what it is, the definitions, the data's
 * limits and how to refresh it, with its line and one row per decision rendered from the committed file, on the page and
 * in its Markdown view alike, never typed.
 */
describe("the replay of the team's shadow decisions, on the docs page (shadow replay SR11)", () => {
  const SHADOW = shadow as unknown as ShadowReplayResults;
  const section = SOURCE.slice(SOURCE.indexOf("## Real decisions, replayed\n"), SOURCE.indexOf("## What it does not cover\n"));
  // Each distinct reason once, numbered in the order the table first meets it, with the decisions it applies to.
  const REASONS = [...new Set(SHADOW.decisions.map((decision) => decision.reason).filter((reason): reason is string => reason !== null))];
  const NOTES = REASONS.map((reason) => `${SHADOW.decisions.filter((decision) => decision.reason === reason).map((decision) => decision.id).join(", ")}: ${reason}`);
  const noteOf = (reason: string | null) => (reason === null ? null : REASONS.indexOf(reason) + 1);
  const cellsOf = (markup: string) => [...markup.matchAll(/<tr>(.*?)<\/tr>/g)].slice(1).map((row) => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => text(cell[1])));
  const notesOf = (markup: string) => [...markup.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((item) => text(item[1]));

  it("has its section after the scenarios and before what the lab does not cover, with its line and its table", () => {
    expect(SOURCE.indexOf("## Real decisions, replayed\n")).toBeGreaterThan(SOURCE.indexOf("### Clean bills\n"));
    expect(section.length).toBeGreaterThan(1000);
    expect(section.indexOf("<ShadowReplaySummary />")).toBeGreaterThan(-1);
    expect(section.indexOf("<ShadowReplayTable />")).toBeGreaterThan(section.indexOf("### Every decision\n"));
    expect(SOURCE).toContain("[Real decisions, replayed](#real-decisions-replayed)");
  });

  it("says what it is, what then, now and a wrong payment mean, and the data's limits", () => {
    for (const part of [
      "The team runs its own workspaces this way on Arc testnet.",
      "Each decision is rebuilt from its exported record: the signed ledger entry the agent wrote when it decided, and a few facts read beside it at export.",
      "The payee's role comes from the payee's row as it is at export.",
      "are kept only while the address has not changed since the decision.",
      "or to the last minute of its day when the entry was written after midnight.",
      "four answers are handed in as recorded rather than worked out: the contract's, the room left under the agent's spending limit, earlier work for the same purchase order or deliverable, and the project's budget.",
      "Code let money move then when it let through a payment or a schedule: in shadow mode a payment that passed waited for the person's verdict instead of being sent",
      "money that moves although code records a stop",
      "A decision that cannot be rebuilt is still a wrong payment when, in any way the record does not rule out, money moves where code stopped it then or where the person disagreed.",
      "The line above counts each decision once, and a wrong payment only as one, whatever else it is: a decision where code records a stop and money moves all the same is never counted as stopped.",
      "Where the record lacks one, it is set both ways.",
      "A payment or schedule decided on or before Oct 13, 2026, the day the check for earlier work was added, has no answer to that check in its record, so that answer is set both ways for it.",
      "a decision made before the check for earlier work existed has no answer to it. The replay runs such a decision both ways.",
      "**Earlier work before Oct 13, 2026.**",
      "An entry records earlier work for the same purchase order or delivered work only when the check finds some, and the check was added on Oct 13, 2026.",
      "with no earlier work, and with an earlier milestone for the same delivered work, which today's code holds for a person. Where that changes whether money moves, the decision cannot be rebuilt.",
      "An answer to pay or schedule a EURC bill, a payout to another chain or a bank payout is not rebuilt",
      "A hold, a flag or a request for information on one moves no money and meets no rule, so it is replayed",
      "The model answers exactly as it did: the same action, and the same day for a schedule. It is not asked again.",
      "**Then** is what code did at the time",
      "**Now** is what today's code does with the same answer on the same facts",
      "**Cannot rebuild** means the outcome depends on a fact the record does not carry.",
      "A **wrong payment** is money that moves now where code stopped it then or where the person disagreed",
      "**The team's own workspaces only.**",
      "Customers' workspaces are never read into the file, whatever they hold.",
      "**Facts the record does not carry are never guessed.**",
      "**Recorded answers, not the model's judgement.**",
      "A result with a reason names a note under the table, which gives each reason once with the decisions it applies to.",
      "npm run quality-lab:shadow\nnpm run quality-lab",
      "src/lib/data/quality-lab-shadow.json",
    ]) {
      expect(section + SOURCE, part).toContain(part);
    }
  });

  it("types no figure: its line and its rows come from the committed file", () => {
    expect(section).not.toMatch(/\d+ (real )?decisions?\b/);
    expect(section).not.toMatch(/shadow-\d+/);
  });

  it("claims no more than the export reads: not the entry alone, not money sent in shadow mode, not every answer on a EURC bill refused", () => {
    expect(section).not.toContain("and nothing else");
    expect(section).not.toContain("Money moved then when");
    expect(section).not.toMatch(/^- \*\*USDC bills on Arc\.\*\* A EURC bill/m);
  });

  it("never states a wrong payment in a decision that cannot be rebuilt without its condition: code stopped it then, or the person disagreed", () => {
    expect(section).not.toContain("is still a wrong payment when money moves in any way the record does not rule out");
  });

  it("renders the line and every decision's row from the committed file", () => {
    const components = useMDXComponents();
    expect(components.ShadowReplaySummary).toBe(ShadowReplaySummary);
    expect(components.ShadowReplayTable).toBe(ShadowReplayTable);
    expect(text(renderToStaticMarkup(<ShadowReplaySummary />))).toBe(shadowReplayWords(SHADOW.summary));
    const markup = renderToStaticMarkup(<ShadowReplayTable />);
    const head = [...markup.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((cell) => text(cell[1]));
    expect(head).toEqual([...SHADOW_TABLE_HEAD]);
    const rows = cellsOf(markup);
    expect(rows).toEqual(
      SHADOW.decisions.map((decision) => [
        expect.stringMatching(new RegExp(`^${decision.id}, [A-Z][a-z]{2} \\d{1,2}$`)),
        answerWords(decision.answer),
        verdictWords(decision.verdict),
        replayOutcomeWords(decision.then),
        replayOutcomeWords(decision.now),
        replayResultWords(decision, noteOf(decision.reason)),
      ])
    );
    expect(rows).toHaveLength(SHADOW.summary.decisions);
    // The id and the day stand on two lines when the column is narrow, but say what the Markdown view's cell says.
    expect(rows.map((row) => row[0])).toEqual(shadowRows().map((row) => row[0]));
  });

  it("keeps each result to a few words, and gives each distinct reason once, in a numbered note under the table", () => {
    expect(REASONS.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(<ShadowReplayTable />);
    const rows = cellsOf(markup);
    for (const row of rows) {
      expect(row[5].length, row[5]).toBeLessThanOrEqual(60);
    }
    SHADOW.decisions.forEach((decision, index) => {
      if (decision.reason !== null) expect(rows[index][5], decision.id).toMatch(new RegExp(`, note ${noteOf(decision.reason)}$`));
    });
    expect(text(markup.slice(markup.indexOf("</table>")))).toMatch(new RegExp(`^${SHADOW_NOTES_HEAD} `));
    expect(markup).toMatch(/<\/table>.*<ol[^>]*>/);
    expect(notesOf(markup)).toEqual(NOTES);
    for (const reason of REASONS) {
      expect(text(markup).split(reason).length - 1, reason).toBe(1);
    }
  });

  it("writes no notes when no decision has a reason", () => {
    const decisions = SHADOW.decisions.map((decision) => ({ ...decision, class: "same" as const, reason: null }));
    const markup = renderToStaticMarkup(<ShadowReplayTable results={{ summary: SHADOW.summary, decisions }} />);
    expect(text(markup.slice(markup.indexOf("</table>")))).toBe("");
    expect(markup).not.toContain("<ol");
  });

  it("styles each result from its class and wrong payment, never from its words: a wrong payment first, whatever its class", () => {
    const base = SHADOW.decisions[0];
    const decisions: ShadowReplayResults["decisions"] = [
      { ...base, id: "same-wrong", class: "same", reason: null, wrongPayment: true },
      { ...base, id: "same-right", class: "same", reason: null, wrongPayment: false },
      { ...base, id: "cannot-wrong", class: "cannot_rebuild", now: null, reason: "Why.", wrongPayment: true },
      { ...base, id: "stopped", class: "now_stopped", reason: "Because.", wrongPayment: false },
      { ...base, id: "stop-ignored", class: "now_stopped", reason: "Why.", wrongPayment: true },
    ];
    const markup = renderToStaticMarkup(<ShadowReplayTable results={{ summary: SHADOW.summary, decisions }} />);
    const cells = [...markup.matchAll(/<tr>(.*?)<\/tr>/g)].slice(1).map((row) => [...row[1].matchAll(/<td class="([^"]*)"[^>]*>(.*?)<\/td>/g)].at(-1)!);
    expect(cells.map((cell) => text(cell[2]))).toEqual(["Same, a wrong payment", "Same", "Cannot rebuild, a wrong payment, note 1", "Now stopped, note 2", "A wrong payment, note 1"]);
    // A reason two decisions share is one note, numbered where the table first meets it.
    expect(notesOf(markup)).toEqual(["cannot-wrong, stop-ignored: Why.", "stopped: Because."]);
    const classes = cells.map((cell) => cell[1].split(/\s+/));
    expect(classes.map((names) => names.includes("text-refused"))).toEqual([true, false, true, false, true]);
    expect(classes[1]).toContain("text-ink-2");
    expect(classes[3]).toContain("text-held");
  });

  it("writes the same line, rows and notes in the page's Markdown view", () => {
    expect(MARKDOWN).toContain(shadowReplayWords(SHADOW.summary));
    expect(MARKDOWN).toContain(`| ${SHADOW_TABLE_HEAD.join(" | ")} |`);
    const rows = shadowRows();
    expect(rows.map((row) => row.at(-1))).toEqual(SHADOW.decisions.map((decision) => replayResultWords(decision, noteOf(decision.reason))));
    for (const row of rows) {
      expect(MARKDOWN, row[0]).toContain(`| ${row.join(" | ")} |`);
    }
    const lastRow = `| ${rows.at(-1)!.join(" | ")} |`;
    const notes = NOTES.map((note, index) => `${index + 1}. ${note}`).join("\n");
    expect(MARKDOWN).toContain(`${lastRow}\n\n**${SHADOW_NOTES_HEAD}**\n\n${notes}\n`);
    for (const reason of REASONS) {
      expect(MARKDOWN.split(reason).length - 1, reason).toBe(1);
    }
  });
});
