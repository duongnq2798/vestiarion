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

  it("asks it second, right after whether crypto is needed to try it", () => {
    expect(landingFaq(true).slice(0, 2).map((item) => item.question)).toEqual(["Do I need crypto to try it?", "How long does it take to start?"]);
  });
});
