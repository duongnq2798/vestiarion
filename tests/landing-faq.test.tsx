import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Faq, landingFaq } from "@/components/landing/Faq";
import { ISSUES_URL } from "@/lib/site-links";

const text = (node: unknown) =>
  renderToStaticMarkup(<>{node as React.ReactNode}</>)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'");

/** The landing's questions (landing clarity F1), answered as the product behaves today. */
describe("the landing's FAQ", () => {
  it("asks what an owner asks first: trying it safely, who controls the money, what pays on its own, failures, tools, crypto, cost, privacy", () => {
    expect(landingFaq(true).map((item) => item.question)).toEqual([
      "Can I try Vestiarion without real money?",
      "Who controls the money and approves payments?",
      "Can Vestiarion pay bills and contractors automatically?",
      "What happens if a payment fails?",
      "Does Vestiarion work with my existing tools?",
      "Do I need crypto or a wallet to get started?",
      "What does Vestiarion cost?",
      "Who can see our bills?",
    ]);
  });

  it("keeps shadow mode, Arc testnet and Arc mainnet apart, and promises Arc mainnet only where it is open", () => {
    const open = text(landingFaq(true)[0].answer);
    // Unless the owner lets the agent pay earned vendors on their own, on Arc testnet (earned vendors AL28).
    expect(open).toContain("nothing is paid until a person agrees, unless you let the agent pay vendors that earned it under your rule, on Arc testnet. No wallet or funds are needed.");
    expect(open).toContain("Arc testnet, where test USDC has no market value, or on Arc mainnet, where payments move real USDC.");
    expect(text(landingFaq(false)[0].answer)).toContain("where payments move real USDC, for the accounts it is open to so far.");
  });

  it("says the AI only proposes, code checks, a person decides what code stops, and the wallet's contract bounds Arc mainnet", () => {
    const control = text(landingFaq(true)[1].answer);
    expect(control).toContain("The AI proposes each payment");
    expect(control).toContain("waits for a person in Approvals");
    expect(control).toContain("only through a spending-limit contract your own wallet deploys");
  });

  it("never promises a failed payment can be reversed: nothing is paid twice, and a refund is a new payment", () => {
    const failed = text(landingFaq(true)[3].answer);
    expect(failed).toContain("Nothing is paid twice.");
    expect(failed).toContain("only a person can send a new one");
    expect(failed).toContain("final and cannot be reversed: a refund is a new payment back from the payee.");
  });

  it("says what it costs: free to try, no published price, only a payment's network fee once the agent pays", () => {
    const entry = landingFaq(true).find((item) => item.question === "What does Vestiarion cost?");
    expect(entry?.answer).toBe(
      "Trying it is free, and there is no published price yet. Shadow mode needs no wallet and no funds. Once the agent pays bills itself, each payment carries only its network fee, in USDC: on Arc, less than a cent. A payout to another chain carries that chain's transfer fee too."
    );
  });

  it("is one group of disclosures, one open at a time, each question a heading, with the docs and the support link beside it", () => {
    const markup = renderToStaticMarkup(<Faq mainnetForEveryone />);
    expect(markup.match(/<details[^>]*name="landing-faq"/g)).toHaveLength(landingFaq(true).length);
    expect(markup.match(/<h3\b/g)).toHaveLength(landingFaq(true).length);
    expect(markup).toContain("Everything you need to know.");
    expect(markup).toContain('href="/docs"');
    expect(markup).toContain(`href="${ISSUES_URL}"`);
    // Nothing opens on its own, and the questions are not cards.
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).not.toContain("shadow-surface");
  });
});
