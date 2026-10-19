import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillJourney } from "@/components/landing/BillJourney";
import type { TeamJourney, TeamJourneyEvent, TeamJourneys } from "@/lib/team-journey";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const event = (seq: number, action: string, recordedAt = "2026-10-18T07:08:09Z"): TeamJourneyEvent => ({
  seq, action, recordedAt,
  link: { body_hash: "b".repeat(64), signature: "a".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: "0123456789abcdef" },
});
const direct: TeamJourney = {
  amount: 17.42, currency: "USDC", network: "arc-mainnet", status: "paid",
  received: event(11, "create_invoice"), check: event(12, "ap_decision"), hold: event(13, "ap_decision"),
  approval: event(14, "approval_given", "2026-10-18T07:08:19Z"), record: event(15, "payment_executed"),
  observed: { hasPurchaseOrder: true, goodsReceived: false, purchaseOrderRequired: true, riskLevel: "clear" },
  rule: "counterparty.new_payee", publicKeys: {},
  payment: {
    route: "direct", confirmationRecordedAt: "2026-10-18T07:08:10Z",
    source: { chain: "ARC", hash: `0x${"ab".repeat(32)}`, url: `https://arcscan.app/tx/0x${"ab".repeat(32)}` },
    destination: { chain: "ARC", hash: `0x${"ab".repeat(32)}`, url: `https://arcscan.app/tx/0x${"ab".repeat(32)}` },
    feeUsdc: null,
  },
};
const base: TeamJourney = {
  ...direct,
  amount: 32.71,
  payment: { ...direct.payment, route: "cctp", destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` } },
};
async function complete(node: ReactElement) {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}

describe("the bill's process and observed evidence", () => {
  it("explains general progress with a finite decorative line, gated off for reduced motion", () => {
    const css = readFileSync(path.join(process.cwd(), "src/components/landing/BillJourney.module.css"), "utf8");
    const line = css.match(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{\s*\.process::before\s*\{([^}]+)\}/)?.[1] ?? "";
    const animation = line.match(/animation:\s*([^;]+)/)?.[1] ?? "";
    expect(animation).not.toBe("");
    const duration = animation.match(/([\d.]+)(ms|s)\b/);
    expect(duration).not.toBeNull();
    expect(Number(duration?.[1]) * (duration?.[2] === "s" ? 1000 : 1)).toBeLessThanOrEqual(2500);
    expect(animation).not.toContain("infinite");
    expect(css).not.toMatch(/(?:opacity:\s*0\b|visibility:\s*hidden)/);
  });

  it("renders the complete general process before a pending evidence read settles", () => {
    const markup = renderToStaticMarkup(<BillJourney source={new Promise<TeamJourneys | null>(() => {})} />);
    const words = text(markup);
    for (const label of ["Read", "Check", "Decide", "Pay", "Record", "The AI suggests. Your rules in code decide.", "Loading the bill's recorded evidence"]) expect(words).toContain(label);
    expect(markup).toContain('id="bill-journey"');
    expect(markup).not.toContain("17.42");
    expect(words).not.toContain("Receipt on file");
  });

  it("shows sourced recorded events with checkable signatures and honest timestamp provenance", async () => {
    const markup = await complete(<BillJourney source={Promise.resolve({ direct, base: null })} />);
    const words = text(markup);
    expect(words).toContain("Vestiarion team workspace");
    expect(words).toContain("17.42 USDC");
    for (const label of ["Bill recorded", "Decision recorded", "Hold recorded", "Approval recorded", "Payment recorded"]) expect(words).toContain(label);
    expect(markup).toMatch(/datetime="2026-10-18T07:08:19Z"/i);
    expect(words).toContain("Recording times can follow the action");
    expect(words).toContain("counterparty.new_payee");
    expect(words).toContain("Purchase order recorded");
    expect(words).toContain("Goods receipt not confirmed");
    expect(words).not.toContain("Work delivered");
    expect(markup.match(/Check its signature/g)).toHaveLength(5);
    expect(markup).toContain('id="journey-entry-approval-14"');
    expect(words).toContain("A signature check verifies the signed hash link, not the public description or payment settlement.");
  });

  it("leaves missing events and checks unknown instead of completing the story from the transaction", async () => {
    const bill: TeamJourney = { ...direct, received: null, check: null, hold: null, approval: null, record: null, rule: null, observed: { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null } };
    const markup = await complete(<BillJourney source={Promise.resolve({ direct: bill, base: null })} />);
    const words = text(markup);
    expect(words.match(/Not available in this bill's record/g)).toHaveLength(5);
    expect(words).not.toContain("Check its signature");
    expect(words).not.toContain("Purchase order recorded");
    expect(words).not.toContain("counterparty.new_payee");
    expect(words).not.toContain("Second member approved");
    expect(words).not.toMatch(/19 seconds|first mainnet|Receipt on file|every stage recorded/i);
  });

  it("keeps payment confirmation recording separate from later approval recording and invents no elapsed duration", async () => {
    const markup = await complete(<BillJourney source={Promise.resolve({ direct, base: null })} />);
    expect(text(markup)).toContain("Payment confirmation recorded");
    expect(markup).toMatch(/datetime="2026-10-18T07:08:10Z"/i);
    expect(markup).toMatch(/datetime="2026-10-18T07:08:19Z"/i);
    expect(text(markup)).not.toMatch(/paid at|approved at|seconds after|in \d+ seconds|block time/i);
  });

  it("shows Base settlement with separate burn and mint links, without unrecorded fees or contract claims", async () => {
    const markup = await complete(<BillJourney source={Promise.resolve({ direct: null, base })} />);
    const words = text(markup);
    expect(words).toContain("Paid on Base");
    expect(words).toContain("32.71 USDC");
    expect(markup).toContain(`href="${base.payment.source.url}"`);
    expect(markup).toContain(`href="${base.payment.destination.url}"`);
    expect(words).toContain("Verify the burn on Arc mainnet");
    expect(words).toContain("Verify the mint on Base");
    expect(words).not.toMatch(/CCTP fee|version 2|Forwarding Service/);
    expect(words).toContain("What this bill's record shows.");
    expect(words).not.toContain("No direct bill record is available");
    expect(markup.match(/Verify the mint on Base/g)).toHaveLength(1);
  });

  it("does not publish a Base settlement claim for an Arc destination", async () => {
    const incomplete: TeamJourney = { ...base, payment: { ...base.payment, destination: direct.payment.destination } };
    const markup = await complete(<BillJourney source={Promise.resolve({ direct: null, base: incomplete })} />);
    expect(text(markup)).not.toContain("Paid on Base");
    expect(text(markup)).not.toContain("32.71");
  });

  it("uses the same Base bill as the hero when both routes have recorded payments", async () => {
    const bill: TeamJourney = { ...base, received: event(21, "create_invoice"), check: event(22, "ap_schedule"),
      hold: event(22, "ap_schedule"), approval: event(24, "approval_paid"), record: event(24, "approval_paid") };
    const markup = await complete(<BillJourney source={Promise.resolve({ direct, base: bill })} />);
    for (const anchor of ["check-22", "hold-22", "approval-24"]) expect(markup).toContain(`id="journey-entry-${anchor}"`);
    expect(markup).not.toContain('id="journey-entry-approval-14"');
    expect(markup.match(/Check its signature/g)).toHaveLength(5);
    expect(text(markup)).not.toContain("17.42 USDC");
    expect(markup.match(/Verify the mint on Base/g)).toHaveLength(1);
  });

  it("keeps an explicit unavailable state and the process explanation when the read fails", async () => {
    const source = Promise.reject<TeamJourneys | null>(new Error("database unavailable"));
    void source.catch(() => {});
    const markup = await complete(<BillJourney source={source} />);
    expect(text(markup)).toContain("The team's recorded evidence is unavailable right now.");
    expect(text(markup)).toContain("Your rules in code decide.");
    expect(text(markup)).not.toContain("0.10");
    expect(markup).not.toMatch(/href="https:\/\/[^\"]*\/tx\//);
  });
});
