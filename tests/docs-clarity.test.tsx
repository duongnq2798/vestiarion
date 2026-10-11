import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Action, DocsCallout } from "@/components/docs/DocsCallout";
import { DocsHeading, stepOf } from "@/components/docs/DocsHeading";
import { mdxToMarkdown } from "@/lib/docs/markdown";
import { readSource } from "@/lib/docs/content";

/**
 * The docs' reading pieces (docs clarity T2, C2, C4): a numbered step's heading, callouts that say what kind they are in
 * words, and a guide's next step in the app, on the page and in the Markdown view.
 */
const ORIGIN = "https://www.vestiarion.xyz";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("a numbered step's heading", () => {
  it("reads its number and words, and nothing else", () => {
    expect(stepOf("1. Sign in")).toEqual({ number: "1", words: "Sign in" });
    expect(stepOf("12. Check it")).toEqual({ number: "12", words: "Check it" });
    expect(stepOf("What to do next")).toBeNull();
    expect(stepOf("2026 plans")).toBeNull();
  });

  it("draws the number in a badge, keeping its id and its accessible text", () => {
    const markup = renderToStaticMarkup(
      <DocsHeading depth={2} id="1-sign-in">
        1. Sign in
      </DocsHeading>
    );
    expect(markup).toMatch(/^<h2 id="1-sign-in"/);
    expect(text(markup)).toContain("1 . Sign in");
    expect(markup).toContain('<span class="sr-only">.</span>');
  });

  it("leaves a heading that is not a step as it is", () => {
    const markup = renderToStaticMarkup(
      <DocsHeading depth={3} id="tables">
        Tables
      </DocsHeading>
    );
    expect(markup).toMatch(/^<h3 id="tables"[^>]*>Tables<a /);
  });
});

describe("a callout's kind", () => {
  it("is written beside its title on the page, so it never rests on colour alone", () => {
    const words = text(renderToStaticMarkup(<DocsCallout kind="real-money" title="Live payments move USDC">Read the controls first.</DocsCallout>));
    expect(words).toContain("Real money Live payments move USDC");
    expect(words).toContain("Read the controls first.");
    expect(text(renderToStaticMarkup(<DocsCallout kind="warning">Careful.</DocsCallout>))).toContain("Warning");
  });

  it("leads its quote in the Markdown view", () => {
    expect(mdxToMarkdown('<Callout kind="real-money" title="Live payments move USDC">\nRead the controls first.\n</Callout>\n', ORIGIN)).toBe(
      "> **Real money: Live payments move USDC** Read the controls first.\n"
    );
    expect(mdxToMarkdown('<Callout kind="tip">\nStart small.\n</Callout>\n', ORIGIN)).toBe("> **Tip** Start small.\n");
    expect(mdxToMarkdown('<Callout title="Plain">\nAs before.\n</Callout>\n', ORIGIN)).toBe("> **Plain** As before.\n");
  });
});

describe("a guide's next step in the app", () => {
  it("is one link, in this tab", () => {
    const markup = renderToStaticMarkup(<Action href="/onboarding?shadow=1">Try it with your bills</Action>);
    expect(markup).toMatch(/<a [^>]*href="\/onboarding\?shadow=1"[^>]*>Try it with your bills<\/a>/);
    expect(markup).not.toContain("_blank");
  });

  it("is a Markdown link of its own in the Markdown view", () => {
    expect(mdxToMarkdown('Before.\n\n<Action href="/onboarding?shadow=1">Try it with your bills</Action>\n\nAfter.\n', ORIGIN)).toContain(
      `[Try it with your bills](${ORIGIN}/onboarding?shadow=1)`
    );
  });
});

describe("the quickstart", () => {
  const guide = readSource("guides/try-it");

  it("reaches a first decision before any wallet, and says so", () => {
    expect(guide).toContain("no wallet, no USDC and no API key");
    const steps = [...guide.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => match[2]);
    expect(steps).toEqual(["Sign in", "Create a workspace in shadow mode", "Add a supplier", "Add one of your bills", "See what the agent decided", "Read why", "Agree or disagree"]);
    expect(guide.indexOf("## What to do next")).toBeGreaterThan(guide.indexOf("## 7. Agree or disagree"));
  });

  it("offers two next paths that are not the same, and warns before real money", () => {
    expect(guide).toContain("### Keep running in shadow mode");
    expect(guide).toContain("### Prepare to go live");
    expect(guide).toMatch(/<Callout kind="real-money"/);
    expect(guide).toContain("A decision to pay is not a payment.");
  });
});
