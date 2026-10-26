import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAYEE_LOCK_EXAMPLE } from "@/components/landing/payee-lock-example";
import { PRINCIPLES, Safety } from "@/components/landing/Safety";
import { SAFETY_EXAMPLE } from "@/components/landing/safety-example";
import { ARC_TESTNET } from "@/lib/network";
import { ruleLabel } from "@/lib/rule-words";

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/**
 * The landing's safety section (landing clarity S2): what the model proposes, what decides, one real refusal, and the
 * payee lock holding a changed address until its payment settled on Arc (docs/superpowers/specs/2026-10-26-landing-
 * payee-lock-design.md PLL1-PLL8).
 */
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
    // Each principle, then the two worked cases (PLL1).
    expect(markup.match(/<h3\b/g)).toHaveLength(PRINCIPLES.length + 2);
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

  describe("the payee lock's worked case", () => {
    const at = markup.indexOf('aria-labelledby="safety-payee-lock-title"');
    const block = markup.slice(at, markup.indexOf("</section>", at));
    const words = text(block);
    const e = PAYEE_LOCK_EXAMPLE;
    const hash = "0x49787501b6738cc2653bfb93a51293d4f036ff85a41115dc7f5b5f07db720551";
    const explorer = `${ARC_TESTNET.explorer}/tx/${hash}`;

    it("comes after the refusal, which stays the first case (PLL1)", () => {
      expect(markup.indexOf('aria-labelledby="safety-example-title"')).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(markup.indexOf('aria-labelledby="safety-example-title"'));
      expect(words).toContain("What happens when a payment address changes?");
      expect(markup.match(/<ol\b/g)).toHaveLength(2);
    });

    it("is labelled with its network and as live, never shadow mode, in the team's own workspace (PLL2)", () => {
      expect(e.network).toBe(ARC_TESTNET);
      expect(e.mode).toBe("live");
      expect(words).toContain(`A historical team payment · ${ARC_TESTNET.label} · live · Vestiarion team workspace · Oct 20, 2026`);
      expect(words).not.toContain("shadow mode");
      expect(markup).toContain('dateTime="2026-10-20"');
      // Neither the workspace nor the vendor is named.
      expect(words).not.toMatch(/pinecrest|northwind/i);
    });

    it("names the payee lock and says what it does, apart from what happened (PLL5)", () => {
      expect(words).toContain(
        "The payee lock. With it on, a changed payment address is paid only after a person confirms it, recording how they checked it with the vendor, and after any wait you set."
      );
      expect(words).toContain("Whoever entered the address cannot confirm it while someone else can.");
      expect(words).toContain("An owner turns it on in Settings, with a wait of 4, 24, 48 or 72 hours, or none.");
      expect(words).toContain("A workspace created on Arc mainnet starts with it on, with no wait.");
      // Why a wait helps is general, so it sits with the lock's description, before the observed steps.
      const general = text(block.slice(0, block.indexOf("<ol")));
      expect(general).toContain("A wait gives the real vendor time to notice a change they did not make.");
    });

    it("sets the description over the proof on a wide screen, each at its own height (PLL5)", () => {
      // Two rows on the left: the description's own height, then the proof, the row that takes what the steps leave.
      expect(block).toMatch(/<div class="[^"]*\blg:grid-cols-\[minmax\(0,2fr\)_minmax\(0,3fr\)\][^"]*\blg:grid-rows-\[auto_1fr\][^"]*">/);
      expect(block).toMatch(/<ol class="[^"]*\blg:row-span-2\b[^"]*">/);
    });

    it("follows five steps, each at the time its signed ledger entry was recorded (PLL3)", () => {
      const steps = block.match(/<ol\b[\s\S]*?<\/ol>/)?.[0] ?? "";
      expect(steps.match(/<li\b/g)).toHaveLength(5);
      expect(e.steps.map((step) => step.kind)).toEqual(["The address changes", "Code holds it", "A second person confirms", "Code holds it again", "Paid"]);
      expect(e.steps.map((step) => [step.entry, step.at])).toEqual([
        [4839, "2026-10-20T11:14:01Z"],
        [4843, "2026-10-20T11:15:17Z"],
        [4863, "2026-10-20T12:10:52Z"],
        [4866, "2026-10-20T12:11:00Z"],
        [4919, "2026-10-20T15:16:07Z"],
      ]);
      for (const step of e.steps) {
        expect(words).toContain(`${step.at.slice(11, 19)} UTC · entry #${step.entry}`);
        expect(markup).toContain(`dateTime="${step.at}"`);
      }
      expect(words).toContain("The payee lock was already on, with a 4-hour wait after a change.");
      expect(words).toContain(`The lock was turned on at 11:12:39 UTC, as entry #${e.lockOn.entry}.`);
      expect(words).toContain("After the wait, the agent paid 3.00 USDC to the confirmed address.");
    });

    it("names the two rules that held the payment, in the product's words (PLL3)", () => {
      expect(words).toContain("counterparty.address_unconfirmed");
      expect(words).toContain("counterparty.cooling_off");
      expect(ruleLabel("counterparty.address_unconfirmed")).toContain("no one had confirmed");
      expect(ruleLabel("counterparty.cooling_off")).toContain("the payee lock makes it wait");
      expect(words).toContain("No one had confirmed the new address.");
      expect(words).toContain("Code held it for the 4-hour wait.");
    });

    it("says in each step only what that workspace recorded, never why the lock exists (PLL3)", () => {
      const steps = text(block.match(/<ol\b[\s\S]*?<\/ol>/)?.[0] ?? "");
      const [changed, , confirmed, heldAgain] = e.steps;
      expect(steps).toContain(`The address was confirmed by then, but it had changed at ${changed.at.slice(11, 19)} UTC, less than an hour earlier.`);
      expect(Date.parse(confirmed.at)).toBeLessThan(Date.parse(heldAgain.at));
      expect(Date.parse(heldAgain.at) - Date.parse(changed.at)).toBeLessThan(3_600_000);
      expect(steps).not.toMatch(/notice|gives the real vendor|in case/i);
    });

    it("quotes the refusal of the member who entered the address as the product words it (PLL3)", () => {
      const refusal = "You entered or asked for this address, so someone else confirms it.";
      expect(words).toContain(`"${refusal}"`);
      expect(source("src/lib/counterparty-address.ts")).toContain(`"${refusal}"`);
      expect(words).toContain("The refused confirmation is not a ledger entry.");
    });

    it("links the payment on the explorer, and tells the chain's time from the ledger's (PLL4)", () => {
      expect(e.payment.hash).toBe(hash);
      expect(block).toContain(`href="${explorer}"`);
      expect(words).toContain(`Proof on ${ARC_TESTNET.label}`);
      expect(words).toContain("Block68200055");
      expect(words).toContain("Confirmed on chain15:16:04 UTC");
      expect(words).toContain("Recorded in the ledger15:16:07 UTC");
      expect(markup).toContain('dateTime="2026-10-20T15:16:04Z"');
      // The block settled it before the ledger recorded the payment.
      expect(e.payment.confirmedAt < e.steps[4].at).toBe(true);
    });

    it("says code and people hold the lock, and claims no contract checked the payee (PLL4)", () => {
      expect(words).toContain(
        "Vestiarion's code and your people hold the lock, not a contract. The transaction shows what followed: the payment settled only after both holds ended, to the confirmed address, for the bill's amount."
      );
      expect(words).not.toMatch(/contract (?:checks|checked|refuses|refused|holds|held|blocks|blocked|enforces|enforced)/i);
      expect(words).not.toMatch(/spending-limit contract/i);
    });

    it("links its committed source, and the guide to the payee lock (PLL6)", () => {
      expect(block).toContain("/blob/main/src/components/landing/payee-lock-example.ts");
      expect(words).toContain("View the payee lock case source");
      expect(block).toContain('href="/docs/guides/first-payment#payee-lock"');
      expect(words).toContain("How the payee lock works");
    });

    it("cites the same transaction as the guide and the README (PLL8)", () => {
      expect(source("content/docs/guides/first-payment.mdx")).toContain(explorer);
      expect(source("README.md")).toContain(explorer);
    });
  });

  it("leads to every safety control, and to how a decision is made", () => {
    expect(markup).toContain('href="/docs/guides/controls"');
    expect(text(markup)).toContain("Explore all safety controls");
    expect(markup).toContain('href="/how-it-decides"');
    expect(markup).toContain('href="/docs/research/model-vs-policy"');
  });
});
