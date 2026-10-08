import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { stepState } from "@/components/landing/pipeline/steps";

/**
 * "How a decision becomes an action", told by scrolling (docs/superpowers/specs/2026-10-08-landing-motion-design.md
 * M1): the step being read is active, the ones before it done, the ones after it idle; with no step chosen yet, as in
 * the server's HTML, every step is lit, so nothing depends on the script to be read.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("stepState", () => {
  it("lights every step until one is chosen", () => {
    expect([0, 1, 2, 3, 4].map((index) => stepState(index, null))).toEqual(["lit", "lit", "lit", "lit", "lit"]);
  });

  it("marks the chosen step active, those before it done and those after it idle", () => {
    expect([0, 1, 2, 3, 4].map((index) => stepState(index, 2))).toEqual(["done", "done", "active", "idle", "idle"]);
  });
});

describe("HowItWorks", () => {
  const markup = renderToStaticMarkup(<HowItWorks />);
  const words = text(markup);

  it("keeps every step's words", () => {
    for (const part of [
      "One loop. Two layers of judgment. One receipt chain.",
      "01 · Observe",
      "Compliance",
      "Forecast",
      "02 · Reason",
      "The model proposes.",
      "It can argue. It cannot pay.",
      "03 · Enforce",
      "Code decides.",
      "nothing the model writes can overrule them.",
      "04 · Act",
      "Only then, money moves.",
      "05 · Sign",
      "Every outcome becomes a receipt — refusals included.",
      "the chain verifier names the first entry that breaks.",
    ]) {
      expect(words).toContain(part);
    }
  });

  it("lights every step in the server's HTML, and dims none", () => {
    const states = [...markup.matchAll(/data-step="\d"[^>]*data-state="(\w+)"/g)].map((match) => match[1]);
    expect(states).toEqual(["lit", "lit", "lit", "lit", "lit"]);
    expect(markup).not.toMatch(/data-state="(idle|done|active)"/);
  });

  it("hides the diagram from assistive technology", () => {
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"[^>]*class="[^"]*pipeline-diagram/);
  });
});
