import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { AuditLedger, DomainFilter } from "@/components/vx/AuditLedger";
import { CycleReport } from "@/components/vx/CycleReport";
import type { LedgerEntry } from "@/lib/ledger";

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

const hash = (seed: string) => seed.padEnd(64, "0");

function entry(seq: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq,
    id: `entry-${seq}`,
    ts: "2026-09-29T10:00:00Z",
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: `Paid INV-${seq}`,
    detail: { day: 3 },
    bodyHash: hash(`b${seq}`),
    signature: `sig${seq}`.padEnd(86, "x"),
    prevHash: seq === 1 ? hash("0") : hash(`h${seq - 1}`),
    hash: hash(`h${seq}`),
    signingKeyId: null,
    ...overrides,
  };
}

/** The opening tag of the link whose text is exactly `text`, or of the first link containing it. */
function anchor(markup: string, text: string): string {
  return markup.match(new RegExp(`<a[^>]*>(?:(?!</a>).)*${text}</a>`))?.[0] ?? "";
}

describe("AuditLedger", () => {
  it("renders each entry as a closed disclosure anchored by its sequence number", () => {
    const markup = html(<AuditLedger entries={[entry(1), entry(2)]} />);
    expect(markup).toContain('id="seq-2"');
    expect(markup.match(/<details class="[^"]*disclosure/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<details[^>]* open=""/);
  });

  it("offers to copy the full hash, previous hash, body hash and signature", () => {
    const e = entry(2);
    const markup = html(<AuditLedger entries={[entry(1), e]} />);
    for (const what of ["hash", "previous hash", "body hash", "signature"]) {
      expect(markup).toContain(`aria-label="Copy the ${what} of #0002"`);
    }
    // The full values are on the page to copy, wrapped inside the row.
    expect(markup).toContain(e.signature);
    expect(markup).toContain("break-all");
  });

  it("says whether each entry links to the one before it", () => {
    expect(html(<AuditLedger entries={[entry(1), entry(2)]} />)).toContain("matches hash of #0001");
    expect(html(<AuditLedger entries={[entry(1), entry(2, { prevHash: hash("tampered") })]} />)).toContain("does not match hash of #0001");
    expect(html(<AuditLedger entries={[entry(1)]} />)).toContain("genesis — first link in the chain");
  });

  it("tags a sweep and a risk change in words", () => {
    const markup = html(
      <AuditLedger entries={[entry(3, { action: "compliance_sweep", domain: "compliance" }), entry(4, { action: "risk_level_changed", domain: "compliance" })]} />
    );
    expect(markup).toContain("continuous sweep");
    expect(markup).toContain("risk changed");
  });
});

describe("DomainFilter", () => {
  it("marks All as the filter in force when no domain is chosen", () => {
    const markup = html(<DomainFilter orgSlug="acme" />);
    expect(anchor(markup, "All")).toContain('aria-current="page"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks the chosen domain, and only it", () => {
    const markup = html(<DomainFilter orgSlug="acme" active="ap" />);
    expect(anchor(markup, "Payables")).toContain('aria-current="page"');
    expect(anchor(markup, "Payables")).toContain('href="/o/acme/audit?domain=ap"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("CycleReport", () => {
  it("is an agent-toned card that links the cycle's range in the audit log", () => {
    const markup = html(
      <CycleReport entries={[entry(5), entry(6)]} day={3} since={4} clockMode="simulate" completedAt={null} orgSlug="acme" />
    );
    expect(markup).toContain("border-agent-line");
    expect(markup).toContain("Day 3: the agent logged 2 entries");
    expect(markup).toContain('href="/o/acme/audit?since=4#seq-6"');
  });

  it("renders nothing when the cycle logged nothing", () => {
    expect(html(<CycleReport entries={[entry(2)]} day={3} since={4} clockMode="simulate" completedAt={null} orgSlug="acme" />)).toBe("");
  });
});
