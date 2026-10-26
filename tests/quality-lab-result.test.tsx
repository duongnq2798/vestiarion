import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The Quality Lab's public result (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL7): the committed results'
 * score and wrong payments with their real numbers, each group's count, how the scenarios run, the definitions, and a
 * link to the docs page that does not prefetch; on /open as a section of its own before the method, with no table, and on
 * /how-it-decides after the four claims. `next/link` is stood in for by an anchor that says whether it prefetches.
 */
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...props }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => (
    <a href={href} data-prefetch={prefetch === false ? "off" : undefined} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/platform/open-numbers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/open-numbers")>();
  return { ...actual, readOpenNumbers: vi.fn(async () => { throw new Error("not read here"); }) };
});

import OpenPage from "@/app/open/page";
import { Claims } from "@/components/landing/Claims";
import { QualityLabResult } from "@/components/open/QualityLabResult";
import results from "@/lib/data/quality-lab.json";
import shadow from "@/lib/data/quality-lab-shadow.json";
import { QUALITY_LAB_GROUPS } from "@/lib/quality-lab/scenarios";
import { scoreWords, shadowReplayWords, wrongPaymentWords } from "@/lib/quality-lab/words";

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const markup = renderToStaticMarkup(<QualityLabResult id="quality-lab" />);
const words = text(markup);

describe("the Quality Lab's result (QL7)", () => {
  it("says the score and the wrong payments from the committed results, with their real numbers", () => {
    expect(words).toContain(scoreWords(results.summary));
    expect(words).toContain(`${results.summary.right} of ${results.summary.scenarios} scenarios right`);
    expect(words).toContain(wrongPaymentWords(results.summary.wrongPayments));
    expect(markup).toMatch(/<h2 id="quality-lab"[^>]*>/);
  });

  it("says how the scenarios run, and what right and a wrong payment mean", () => {
    expect(words).toContain(
      "Each scenario runs through the real decision code on every change, with the model's answers scripted, often to what an attacker would want."
    );
    expect(words).toContain("A scenario is right when money moved or stopped as expected, with the expected status and rule.");
    expect(words).toContain(
      "A wrong payment is any transfer or schedule where money should stop, a transfer to an address other than the one on file or for an amount other than the bill's, or a second transfer for one bill."
    );
  });

  it("counts each group's right scenarios, in the groups' order", () => {
    const counts = QUALITY_LAB_GROUPS.map((group) => {
      const mine = results.scenarios.filter((scenario) => scenario.group === group.id);
      return `${group.title} ${mine.filter((scenario) => scenario.right).length} of ${mine.length}`;
    });
    for (const count of counts) expect(words).toContain(count);
    expect(counts.map((count) => words.indexOf(count))).toEqual([...counts.map((count) => words.indexOf(count))].sort((a, b) => a - b));
  });

  it("links the docs page, which it does not prefetch, and draws no table", () => {
    expect(markup).toMatch(/<a href="\/docs\/research\/quality-lab" data-prefetch="off"[^>]*>/);
    expect(markup).not.toContain("<table");
  });

  it("names no network, and says nothing the lab does not do", () => {
    expect(words).not.toMatch(/testnet|mainnet/i);
    expect(words).not.toMatch(/real money|fictional|simulated money|powered by/i);
  });

  it("says, under the score, how the team's real shadow decisions fare through today's code, from the replay's file (shadow replay SR10)", () => {
    const line = shadowReplayWords(shadow.summary);
    expect(line).toMatch(/^\d+ real decisions? from the team's own shadow-mode workspaces, replayed through today's code: /);
    expect(line).toContain(wrongPaymentWords(shadow.summary.wrongPayments));
    expect(words).toContain(line);
    expect(words.indexOf(line)).toBeGreaterThan(words.indexOf("often to what an attacker would want."));
    expect(words.indexOf(line)).toBeLessThan(words.indexOf("A scenario is right when"));
  });

  it("takes the heading level its page needs", () => {
    expect(renderToStaticMarkup(<QualityLabResult id="lab" heading="h3" />)).toMatch(/<h3 id="lab"[^>]*>/);
  });

  it("names what it scores in its heading, so the heading and a section it labels say which scenarios", () => {
    const heading = /<h2 id="quality-lab"[^>]*>(.*?)<\/h2>/s.exec(markup)?.[1] ?? "";
    expect(text(heading)).toBe(`Quality Lab ${scoreWords(results.summary)}`);
  });
});

describe("the Quality Lab on /open (QL7)", () => {
  it("is a section of its own after the networks and before the method", async () => {
    const page = renderToStaticMarkup(await OpenPage({ searchParams: Promise.resolve({}) }));
    const lab = page.indexOf('<section aria-labelledby="quality-lab"');
    expect(lab).toBeGreaterThan(page.indexOf('<section aria-labelledby="testnet"'));
    expect(lab).toBeGreaterThan(page.indexOf('<section aria-labelledby="mainnet"'));
    expect(lab).toBeLessThan(page.indexOf('<section aria-labelledby="method"'));
    expect(text(page)).toContain(scoreWords(results.summary));
  });

  it("is left out of the method's definitions, which hold for the networks' figures, and states its own", async () => {
    const page = text(renderToStaticMarkup(await OpenPage({ searchParams: Promise.resolve({}) })));
    expect(page).toContain("The same definitions hold for every figure of both networks, for every period. The Quality Lab's result above states its own.");
    expect(page).not.toContain("every figure on this page");
  });
});

describe("the Quality Lab on /how-it-decides (QL7)", () => {
  it("follows the four claims, which keep their checks at their head", () => {
    const claims = text(renderToStaticMarkup(<Claims screeningMode="live" />));
    expect(claims.indexOf("Four claims you can check")).toBeLessThan(claims.indexOf("A model can recommend payment."));
    expect(claims.indexOf("The audit log is a cryptographic receipt, not a feed.")).toBeLessThan(claims.indexOf(scoreWords(results.summary)));
    expect(claims).toContain(wrongPaymentWords(results.summary.wrongPayments));
  });
});
