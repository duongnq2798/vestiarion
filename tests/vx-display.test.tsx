import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { Hash, ModeBadge, OutcomeBadge, Reasoning, shortHash } from "@/components/vx/Primitives";
import { ProvenanceBar } from "@/components/vx/Provenance";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("OutcomeBadge", () => {
  it.each([
    ["settled", "Settled on Arc", "text-proof"],
    ["held", "Held for you", "text-held"],
    ["refused", "Refused by guardrail", "text-refused"],
    ["simulated", "Simulated", "hatch"],
    ["scheduled", "Scheduled", "text-ink-2"],
    ["recorded", "Recorded", "text-ink-2"],
  ] as const)("says %s in words, with its glyph and tone", (outcome, word, toneClass) => {
    const markup = html(<OutcomeBadge outcome={outcome} />);
    expect(markup).toContain(word);
    expect(markup).toContain(toneClass);
    expect(markup).toContain("<svg");
  });

  it("uses the caller's label when there is one", () => {
    expect(html(<OutcomeBadge outcome="held" label="Awaiting an approver" />)).toContain("Awaiting an approver");
  });
});

describe("ModeBadge", () => {
  it("renders nothing without a mode", () => {
    expect(html(<ModeBadge />)).toBe("");
  });

  it("names the decision mode", () => {
    expect(html(<ModeBadge mode="llm" />)).toContain(">llm</span>");
  });
});

describe("Hash", () => {
  const value = "0x1234567890abcdef1234567890abcdef";

  it("shortens a long value and keeps all of it in the title", () => {
    expect(shortHash(value)).toBe("0x1234…cdef");
    const markup = html(<Hash value={value} />);
    expect(markup).toContain("0x1234…cdef");
    expect(markup).toContain(`title="${value}"`);
  });

  it("leaves a short value whole", () => {
    expect(shortHash("0xabc")).toBe("0xabc");
  });

  it("says a link opens a new tab", () => {
    const markup = html(<Hash value={value} href="https://testnet.arcscan.app/tx/0x1" />);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("opens in a new tab");
  });

  it("lets the caller colour a plain hash", () => {
    expect(html(<Hash value={value} className="text-ink-2" />)).toContain("text-ink-2");
    expect(html(<Hash value={value} className="text-ink-2" />)).not.toContain("text-ink-3");
  });
});

describe("Reasoning", () => {
  it("marks the facts a reader checks: invoice numbers, amounts and days", () => {
    const markup = html(<Reasoning text="Paid INV-204 for 1,250.00 USDC on day 26." />);
    expect(markup.match(/<span class="[^"]*font-mono/g)).toHaveLength(3);
    expect(markup).not.toContain("rounded-sm");
  });
});

describe("ProvenanceBar", () => {
  const legs = [
    { label: "Payments", detail: "Arc testnet", live: true },
    { label: "Yield", detail: "USYC reserve", live: false },
  ];

  it("says live or simulated in words for every leg", () => {
    const markup = html(<ProvenanceBar legs={legs} />);
    expect(markup).toContain('aria-label="Live and simulated product capabilities"');
    expect(markup).toContain(">Live</span>");
    expect(markup).toContain(">Simulated</span>");
  });

  it("hides each leg's detail below md when compact", () => {
    expect(html(<ProvenanceBar legs={legs} compact />)).toContain("hidden md:inline");
  });

  it("uses no old shadow utility", () => {
    expect(html(<ProvenanceBar legs={legs} />)).not.toContain("surface-shadow");
  });
});

describe("PerformanceHistory", () => {
  it("keeps the score inputs in a closed disclosure", () => {
    const markup = html(<PerformanceHistory score={0.9} inputs={null} />);
    expect(markup).toContain("Performance history · 90.0% clean");
    expect(markup).toMatch(/<details class="[^"]*disclosure/);
    expect(markup).not.toMatch(/<details[^>]* open=""/);
  });

  it("says there is no history without a score", () => {
    expect(html(<PerformanceHistory score={null} inputs={null} />)).toContain("No history yet");
  });
});
