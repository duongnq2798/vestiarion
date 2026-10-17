import { describe, expect, it } from "vitest";
import { landingFaq } from "@/components/landing/Faq";

/** The landing's questions (landing clarity F1), answered as the product behaves today. */
describe("the landing's FAQ", () => {
  it("says how long it takes to start, as the docs' first steps do", () => {
    const entry = landingFaq(true).find((item) => item.question === "How long does it take to start?");
    expect(entry?.answer).toBe(
      "About five minutes. Add a supplier and one of your bills, as a PDF or through the form, and the agent usually decides on it within a minute, with its reasons and the checks it ran. Connecting Xero or HubSpot takes a few clicks more."
    );
  });

  it("says what it costs: free to try, no published price, only a payment's network fee once the agent pays", () => {
    const entry = landingFaq(true).find((item) => item.question === "What does it cost?");
    expect(entry?.answer).toBe(
      "Trying it is free, and there is no published price yet. Shadow mode needs no wallet and no funds. Once the agent pays bills itself, each payment carries only its network fee, in USDC: on Arc, less than a cent. A payout to another chain carries that chain's transfer fee too."
    );
  });

  it("asks how long and what it costs right after whether crypto is needed to try it", () => {
    expect(landingFaq(true).slice(0, 3).map((item) => item.question)).toEqual(["Do I need crypto to try it?", "How long does it take to start?", "What does it cost?"]);
  });
});
