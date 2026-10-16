import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { USE_CASES, UseCases } from "@/components/landing/UseCases";

/**
 * Who it's for (docs/superpowers/specs/2026-10-16-landing-use-case-decisions-design.md): beside each case's story, the
 * agent's decision on its bill, drawn as a decision rather than a receipt: what it checked, each check passed or
 * failed, and what it decided and why.
 */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([:.,])/g, "$1");

const markup = renderToStaticMarkup(<UseCases />);

describe("the use cases' decisions", () => {
  it("draws one decision per case, each with what the agent checked, its decision and the way to how it decides", () => {
    const cards = [...markup.matchAll(/<div role="group" aria-label="Example decision: ([^"]+)"[^>]*>([\s\S]*?How the agent decides)/g)];
    expect(cards.map((card) => card[1])).toEqual(USE_CASES.map((useCase) => useCase.decision.payee));
    for (const [index, card] of cards.entries()) {
      const { decision } = USE_CASES[index];
      const words = text(card[2]);
      expect(words).toContain(`Example decision ${decision.label}`);
      expect(words).toContain(`${decision.amount} USDC`);
      expect(words).toContain("What the agent checked");
      for (const check of decision.checks) expect(words).toContain(`${check.text}: ${check.passed ? "passed" : "failed"}`);
      expect(words).toContain(`Decision: ${decision.reason}`);
      expect(card[2]).toContain('href="/how-it-decides"');
    }
    // A decision is read, not hidden: the old receipt was drawn for the eye alone.
    expect(markup).not.toMatch(/<div aria-hidden="true" class="rounded-2xl/);
  });

  it("does not end every case in a payment: one is held, one is scheduled", () => {
    expect(USE_CASES.map((useCase) => useCase.decision.label)).toEqual(["Paid", "Held for you", "Scheduled", "Paid"]);
  });

  it("holds a bill only for a check that failed, in code, and pays one only when every check passed", () => {
    for (const { decision } of USE_CASES) {
      const failed = decision.checks.filter((check) => !check.passed);
      if (decision.tone === "held") {
        expect(failed.length).toBeGreaterThan(0);
        expect(decision.reason).toContain("Blocked by code, not by the model.");
      } else {
        expect(failed).toEqual([]);
      }
    }
  });

  it("keeps the note that the payees and amounts are examples", () => {
    expect(text(markup)).toContain("Payees and amounts are examples. The steps are what the agent does today.");
  });
});
