import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Heading", () => {
  it("uses a section-sized h2 unless the page chooses another heading level", () => {
    const markup = html(<Heading>Follow the bill</Heading>);
    expect(markup).toMatch(/^<h2\b/);
    expect(markup).toContain("text-section");
  });

  it.each(["h1", "h2", "h3", "p"] as const)("lets the page choose %s independently of its visual size", (tag) => {
    const markup = html(<Heading as={tag} size="display">Every bill.</Heading>);
    expect(markup).toMatch(new RegExp(`^<${tag}\\b`));
    expect(markup).toContain("text-display");
  });

  it("can present the positioning line as a paragraph without creating another main heading", () => {
    const markup = html(<Heading as="p" size="positioning">Your AI agent for bills and payments</Heading>);
    expect(markup).toMatch(/^<p\b/);
    expect(markup).toContain("text-positioning");
    expect(markup).not.toContain("<h1");
  });

  it("keeps the size while inheriting the surrounding text color", () => {
    const markup = html(<Heading className="text-on-agent">Open receipts.</Heading>);
    expect(markup).toContain("text-section");
    expect(markup).toContain("text-on-agent");
    expect(markup).not.toContain("text-ink");
  });

  it("lets the caller override its visual size and forwards document attributes", () => {
    const markup = html(<Heading as="h1" size="display" className="text-2xl text-proof" id="journey-title" aria-describedby="journey-summary" data-stage="read">The way through</Heading>);
    expect(markup).toContain("text-2xl");
    expect(markup).toContain("text-proof");
    expect(markup).not.toContain("text-display");
    expect(markup).toContain('id="journey-title"');
    expect(markup).toContain('aria-describedby="journey-summary"');
    expect(markup).toContain('data-stage="read"');
  });
});

describe("Section", () => {
  it.each([
    ["ground", "bg-ground", "text-ink"],
    ["surface", "bg-surface", "text-ink"],
    ["agent", "bg-agent", "text-on-agent"],
    ["ink", "bg-ink", "text-on-agent"],
  ] as const)("gives a %s region its matching surface and readable text", (tone, background, text) => {
    const markup = html(<Section tone={tone}>A complete record</Section>);
    const outer = markup.slice(0, markup.indexOf(">") + 1);
    expect(outer).toContain(background);
    expect(outer).toContain(text);
    expect(outer.includes("focus-inverse")).toBe(tone === "agent" || tone === "ink");
    expect(outer.includes("focus-default")).toBe(tone === "ground" || tone === "surface");
  });

  it("defaults to a ground section with a bounded, spaced inner container", () => {
    const markup = html(<Section id="journey" aria-labelledby="journey-title" data-stage="record"><Heading id="journey-title">Nothing lost</Heading><p>Every step is in the record.</p></Section>);
    expect(markup).toMatch(/^<section\b/);
    expect(markup).toContain('id="journey"');
    expect(markup).toContain('aria-labelledby="journey-title"');
    expect(markup).toContain('data-stage="record"');
    expect(markup).toContain("bg-ground");
    expect(markup).toMatch(/<div class="[^"]*\bmx-auto\b/);
    expect(markup).toContain("max-w-7xl");
    expect(markup).toContain("px-page");
    expect(markup).toContain("py-section");
    expect(markup).toContain(">Nothing lost</h2>");
    expect(markup).toContain("<p>Every step is in the record.</p>");
    expect(markup).not.toContain("data-reveal");
  });

  it("allows independent overrides for the outer surface and inner layout", () => {
    const markup = html(<Section tone="agent" className="bg-surface text-ink focus-default" containerClassName="max-w-5xl px-8 py-12">Proof</Section>);
    const outer = markup.slice(0, markup.indexOf(">") + 1);
    expect(outer).toContain("bg-surface");
    expect(outer).toContain("text-ink");
    expect(outer).not.toContain("bg-agent");
    expect(outer).not.toContain("text-on-agent");
    expect(outer).toContain("focus-default");
    expect(outer).not.toContain("focus-inverse");
    expect(markup).toContain("max-w-5xl");
    expect(markup).toContain("px-8");
    expect(markup).toContain("py-12");
    expect(markup).not.toContain("max-w-7xl");
    expect(markup).not.toContain("px-page");
    expect(markup).not.toContain("py-section");
    expect(markup).not.toContain("containerClassName");
    expect(markup).not.toContain("tone=");
  });
});

describe("public-page primitive composition", () => {
  it("keeps an inverse eyebrow readable in a blue section without losing its type size", () => {
    const markup = html(<Section tone="agent"><Eyebrow inverse>Check the receipts</Eyebrow></Section>);
    expect(markup).toContain("text-eyebrow");
    expect(markup).toContain("text-on-agent-muted");
    expect(markup).not.toContain("text-ink-3");
    expect(markup).toContain("Check the receipts</span>");
  });

  it("lets callers override the inverse eyebrow color while keeping its type size", () => {
    const markup = html(<Eyebrow inverse className="text-on-agent">One real bill</Eyebrow>);
    expect(markup).toContain("text-eyebrow");
    expect(markup).toContain("text-on-agent");
    expect(markup).not.toContain("text-on-agent-muted");
  });

  it("retains the resting card elevation unless a page explicitly asks for a flat card", () => {
    expect(html(<Card>Product surface</Card>)).toContain("shadow-surface");
    const flat = html(<Card elevation="flat">Payment record</Card>);
    expect(flat).toContain("shadow-flat");
    expect(flat).not.toContain("shadow-surface");
    expect(flat).not.toContain("elevation=");
  });

  it("lets a caller change a flat card's elevation without retaining conflicting shadows", () => {
    const markup = html(<Card elevation="flat" className="shadow-overlay">Open receipt</Card>);
    expect(markup).toContain("shadow-overlay");
    expect(markup).not.toContain("shadow-flat");
    expect(markup).not.toContain("shadow-surface");
  });
});
