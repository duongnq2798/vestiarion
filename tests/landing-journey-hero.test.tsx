import type { ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "@/components/landing/Hero";
import type { TeamJourney, TeamJourneys } from "@/lib/team-journey";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const pending = new Promise<TeamJourneys | null>(() => {});
const payment: TeamJourney = {
  amount: 17.42, currency: "USDC", network: "arc-mainnet", status: "paid",
  received: null, check: null, hold: null, approval: null, record: null,
  observed: { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null },
  rule: null, publicKeys: {},
  payment: {
    route: "direct", confirmationRecordedAt: "2026-10-18T07:08:09Z",
    source: { chain: "ARC", hash: `0x${"ab".repeat(32)}`, url: `https://arcscan.app/tx/0x${"ab".repeat(32)}` },
    destination: { chain: "ARC", hash: `0x${"ab".repeat(32)}`, url: `https://arcscan.app/tx/0x${"ab".repeat(32)}` },
    feeUsdc: null,
  },
};

async function complete(node: ReactElement) {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}

describe("the bill journey hero", () => {
  it("keeps the exact positioning as its sole h1 and the large tagline as a paragraph while evidence is pending", () => {
    const markup = renderToStaticMarkup(<Hero journey={pending} />);
    const headings = [...markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    expect(headings).toHaveLength(1);
    expect(text(headings[0][1]).trim()).toBe("Your AI agent for bills and payments");
    expect(markup).toMatch(/<p\b[^>]*class="[^"]*text-display[^\"]*"[^>]*>Every bill\. A clear way through\.<\/p>/);
    expect(text(markup)).toContain("Try it on your bills");
    expect(text(markup)).toContain("Loading this team's payment record");
  });

  it("puts the app shell in the first HTML with workspace context, a sidebar and real navigation actions", () => {
    const markup = renderToStaticMarkup(<Hero journey={pending} />);
    const words = text(markup);
    for (const phrase of ["Vestiarion team workspace", "Bills & receivables", "Treasury", "Decision record", "View the bill's evidence"]) expect(words).toContain(phrase);
    expect(markup).toContain('aria-label="Workspace navigation preview"');
    expect(markup).toContain('href="#bill-journey"');
    expect(markup).toContain("focus-inverse");
    expect(markup).toContain("focus-default");
    expect(markup).not.toContain('role="application"');
    expect(markup).not.toMatch(/<button\b/);
    for (const invented of ["Northwind", "Kestrel", "0.10 USDC", "17.42", "19 seconds", "Sample bills"]) expect(words).not.toContain(invented);
  });

  it("renders an actual paid amount, status and explorer link from the shared source", async () => {
    const markup = await complete(<Hero journey={Promise.resolve({ direct: payment, base: null })} />);
    const words = text(markup);
    expect(words).toContain("17.42 USDC");
    expect(words).toContain("Paid on Arc mainnet");
    expect(words).toContain("Payment confirmation recorded");
    expect(markup).toContain(`href="${payment.payment.source.url}"`);
    expect(words).toContain("Not available in this bill's record");
    expect(words).not.toContain("Second member approved");
  });

  it("shows an honest unavailable state for an empty or failed read without a historical fallback", async () => {
    for (const failed of [false, true]) {
      const source = failed ? Promise.reject<TeamJourneys | null>(new Error("unreadable")) : Promise.resolve(null);
      void source.catch(() => {});
      const markup = await complete(<Hero journey={source} />);
      expect(text(markup)).toContain("This team's payment record is unavailable right now.");
      expect(text(markup)).not.toContain("Paid on Arc mainnet");
      expect(markup).not.toMatch(/href="https:\/\/[^\"]*\/tx\//);
    }
  });

  it("uses an eligible Base bill when no direct bill is available, with both destination-aware proof links", async () => {
    const base: TeamJourney = { ...payment, amount: 32.71, payment: { ...payment.payment, route: "cctp", destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` } } };
    const markup = await complete(<Hero journey={Promise.resolve({ direct: null, base })} />);
    const words = text(markup);
    expect(words).toContain("32.71 USDC");
    expect(words).toContain("Paid on Base");
    expect(words).not.toContain("Paid on Arc mainnet");
    expect(markup).toContain(`href="${base.payment.source.url}"`);
    expect(markup).toContain(`href="${base.payment.destination.url}"`);
    expect(words).toContain("Verify the burn on Arc mainnet");
    expect(words).toContain("Verify the mint on Base");
  });

  it("links a displayed entry number to that stage's signed-check context in the full journey", async () => {
    const bill: TeamJourney = { ...payment, approval: { seq: 42, action: "approval_given", recordedAt: "2026-10-18T07:08:09Z", link: { body_hash: "b".repeat(64), signature: "a".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null } } };
    const markup = await complete(<Hero journey={Promise.resolve({ direct: bill, base: null })} />);
    expect(markup).toContain('href="#journey-entry-approval-42"');
  });
});
