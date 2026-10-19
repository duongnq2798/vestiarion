import type { ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "@/components/landing/Hero";
import { NAV_ITEMS } from "@/components/vx/nav";
import type { TeamJourney, TeamJourneys, TeamJourneyEvent } from "@/lib/team-journey";

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
    for (const phrase of ["Vestiarion team workspace", "Bills & receivables", "Treasury", "Approvals", "Audit log", "View the bill's evidence"]) expect(words).toContain(phrase);
    const sidebar = text(markup.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "");
    const labels = NAV_ITEMS.filter(item => ["treasury", "approvals", "invoices", "audit"].includes(item.key)).map(item => item.label);
    expect(labels.map(label => sidebar.indexOf(label))).toEqual([...labels.map(label => sidebar.indexOf(label))].sort((a, b) => a - b));
    expect(sidebar).not.toMatch(/Decision record|Rules in code/);
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

  it("prefers the Base bill's schedule, coded hold and human approval when both routes are available", async () => {
    const event = (seq: number, action: string): TeamJourneyEvent => ({ seq, action, recordedAt: "2026-10-18T07:08:09Z", link: { body_hash: "b".repeat(64), signature: "a".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null } });
    const bill: TeamJourney = { ...payment, check: event(41, "ap_schedule"), hold: event(41, "ap_schedule"), approval: event(42, "approval_paid"), record: event(42, "approval_paid"),
      decision: { payOn: "2026-10-22", reason: "no_early_payment_discount" }, rule: "counterparty.new_payee",
      payment: { ...payment.payment, route: "cctp", destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` }, feeUsdc: 0.055026 } };
    const markup = await complete(<Hero journey={Promise.resolve({ direct: payment, base: bill })} />);
    const words = text(markup);
    for (const phrase of ["Agent decided", "Schedule for Oct 22: no early-payment discount, keeping the cash free until it is due.", "0.055 USDC to Base, on top", "Code held it", "First payment to a new address needs a second look.", "A person approved", "Paid on Base", "Payment confirmation recorded"]) expect(words).toContain(phrase);
    for (const anchor of ["check-41", "hold-41", "approval-42"]) expect(markup).toContain(`href="#journey-entry-${anchor}"`);
    expect(markup).toContain("0.055026 USDC");
    expect(markup.match(/<figure\b[\s\S]*?<\/figure>/)?.[0]).not.toMatch(/<img\b|background-image/);
    expect(words).not.toMatch(/Not available|unavailable/);
  });

  it("chooses a complete direct story over a Base payment whose stages are missing", async () => {
    const event = (seq: number, action: string): TeamJourneyEvent => ({ seq, action, recordedAt: "2026-10-18T07:08:09Z", link: { body_hash: "b".repeat(64), signature: "a".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null } });
    const direct: TeamJourney = { ...payment, check: event(61, "ap_pay"), hold: event(61, "ap_pay"), approval: event(62, "approval_paid"), record: event(62, "approval_paid"), rule: "counterparty.new_payee" };
    const base: TeamJourney = { ...payment, amount: 32.71, payment: { ...payment.payment, route: "cctp", destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` } } };
    const markup = await complete(<Hero journey={Promise.resolve({ direct, base })} />);
    const words = text(markup);
    for (const phrase of ["17.42 USDC", "Agent decided", "Pay this bill.", "Code held it", "A person approved", "Paid on Arc mainnet"]) expect(words).toContain(phrase);
    expect(words).not.toMatch(/Not available|unavailable|32\.71|Paid on Base/);
    for (const anchor of ["check-61", "hold-61", "approval-62"]) expect(markup).toContain(`href="#journey-entry-${anchor}"`);
  });

  it("falls back to direct when neither candidate has a complete story", async () => {
    const base: TeamJourney = { ...payment, amount: 32.71, payment: { ...payment.payment, route: "cctp", destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` } } };
    const words = text(await complete(<Hero journey={Promise.resolve({ direct: payment, base })} />));
    expect(words).toContain("17.42 USDC");
    expect(words).toContain("Paid on Arc mainnet");
    expect(words).not.toContain("32.71 USDC");
  });

  it("uses another recorded date and actual fee, and leaves an unavailable reason unknown", async () => {
    const event: TeamJourneyEvent = { seq: 51, action: "ap_schedule", recordedAt: "2026-10-18T07:08:09Z", link: { body_hash: "b".repeat(64), signature: "a".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null } };
    const bill: TeamJourney = { ...payment, check: event, decision: { payOn: "2026-11-09", reason: null },
      payment: { ...payment.payment, route: "cctp", destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` }, feeUsdc: 0.126781 } };
    const words = text(await complete(<Hero journey={Promise.resolve({ direct: null, base: bill })} />));
    expect(words).toContain("Schedule for Nov 9.");
    expect(words).toContain("0.127 USDC to Base, on top");
    expect(words).not.toMatch(/Oct 22|no early-payment discount|Code held it|A person approved/);
    expect(words).toContain("Not available in this bill's record");
  });
});
