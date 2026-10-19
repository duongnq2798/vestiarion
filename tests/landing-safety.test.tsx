import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRINCIPLES, Safety } from "@/components/landing/Safety";
import { SAFETY_EXAMPLE } from "@/components/landing/safety-example";
import { ARC_TESTNET } from "@/lib/network";
import { ruleLabel } from "@/lib/rule-words";

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The landing's safety section (landing clarity S2): what the model proposes, what decides, and one real refusal. */
describe("the landing's safety section", () => {
  const markup = renderToStaticMarkup(<Safety />);

  it("keeps its heading, with the rules' half set apart", () => {
    expect(markup).toContain('id="safety"');
    expect(markup).toContain("Safety and control");
    expect(text(markup)).toContain("The AI suggests. Your rules in code decide.");
    expect(markup).toMatch(/<span class="[^"]*italic[^"]*">Your rules in code decide\.<\/span>/);
  });

  it("states three principles, each saying what holds it: the team, code and a contract, or the ledger", () => {
    expect(PRINCIPLES.map((principle) => principle.title)).toEqual(["You set the rules", "Code enforces them", "Every action is recorded"]);
    expect(markup.match(/<h3\b/g)).toHaveLength(PRINCIPLES.length + 1);
    expect(PRINCIPLES.map((principle) => principle.by)).toEqual([
      "Set by your team",
      "Enforced by code, and on Arc mainnet by a contract",
      "Kept in the signed ledger",
    ]);
  });

  it("promises neither two approvals for every payment nor everything enforced onchain", () => {
    const all = text(markup);
    expect(all).toContain("Two approvals above a figure you choose, 100 USDC by default on Arc mainnet.");
    expect(all).toContain("in a live workspace the agent pays on its own only what passes every check.");
    // A contract is named once, and only for Arc mainnet.
    const contract = PRINCIPLES.flatMap((principle) => principle.points).filter((point) => /contract/i.test(point));
    expect(contract).toHaveLength(1);
    expect(contract[0].startsWith("On Arc mainnet")).toBe(true);
    expect(all).not.toMatch(/every payment needs two|all payments need|everything is (?:enforced )?onchain/i);
  });

  it("shows a real refusal step by step, labelled with its network, and its rule in the product's words", () => {
    const all = text(markup);
    expect(all).toContain("What happens when a rule fails?");
    expect(SAFETY_EXAMPLE.network).toBe(ARC_TESTNET);
    expect(all).toContain(`A historical team decision · ${ARC_TESTNET.label} · shadow mode`);
    expect(all).toContain("Vestiarion team workspace");
    expect(markup).toContain('/blob/main/src/components/landing/safety-example.ts');
    expect(all).toContain("View the historical case source");
    expect(markup).toContain(`dateTime="${SAFETY_EXAMPLE.at}"`);
    expect(markup.match(/<ol\b[\s\S]*?<\/ol>/)?.[0].match(/<li\b/g)).toHaveLength(3);
    expect(all).toContain("workspace.outflow_budget");
    expect(ruleLabel("workspace.outflow_budget")).toContain("spending limit");
    expect(all).toContain("Refused before anything was signed or sent.");
    expect(all).toContain(`ledger entry #${SAFETY_EXAMPLE.entry}`);
  });

  it("leads to every safety control, and to how a decision is made", () => {
    expect(markup).toContain('href="/docs/guides/controls"');
    expect(text(markup)).toContain("Explore all safety controls");
    expect(markup).toContain('href="/how-it-decides"');
    expect(markup).toContain('href="/docs/research/model-vs-policy"');
  });
});
