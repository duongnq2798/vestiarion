import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard from "@/components/ApprovalCard";
import { buttonVariants } from "@/components/ui/Button";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WaitingPayable } from "@/lib/agent/approvals";

/**
 * Decide from a phone (docs/superpowers/specs/2026-10-21-decide-from-a-phone-design.md P1-P4): Approvals and
 * Contractors at 375px show the whole address a payment goes to, give each decision a thumb-sized button below 640px
 * and leave it as it was above, and wrap what was cut.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(),
  rejectInvoiceAction: vi.fn(),
  returnInvoiceAction: vi.fn(),
  addInvoiceDetailsAction: vi.fn(),
}));

const ADDRESS = "0x7a3c9e2b41d05f8a6c1e3b9d2f4a8c6e0b5d1f93";
const PAYABLE: WaitingPayable = {
  id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
  counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  counterpartyName: "Bluebird Logistics",
  riskLevel: "low",
  amount: 8,
  dueDate: "2026-10-09",
  status: "awaiting_info",
  reasoning: "Asked for more information before paying.",
  explanation: "Asked for more information before paying.",
  decidedAt: "2026-09-30T12:04:00.000Z",
  createdBy: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1",
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: ADDRESS,
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "ARC-TESTNET",
  bridgeFeeUsdc: null,
  poReference: null,
  goodsReceived: false,
  addedSinceDecision: null,
  guardrailRule: "invoice.three_way_match",
};

const card = (payable: WaitingPayable = PAYABLE) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ApprovalCard orgSlug="acme" payable={payable} canDecide canEdit viewerId="0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5" sandbox={false} />
    </TooltipProvider>
  );

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const classesOf = (html: string, text: string) => {
  const at = html.indexOf(`>${text}<`);
  const open = html.lastIndexOf("<button", at);
  return open < 0 || at < 0 ? "" : (html.slice(open, at).match(/class="([^"]*)"/)?.[1] ?? "");
};

describe("the touch size (P2)", () => {
  it("is md's 44px below 640px and sm from there up", () => {
    const touch = buttonVariants({ size: "touch" });
    expect(touch).toContain("h-11");
    expect(touch).toContain("sm:h-8");
    expect(touch).toContain("sm:text-xs");
    expect(buttonVariants({ size: "sm" })).toContain("h-8");
  });
});

describe("the approval card on a phone", () => {
  it("shows the whole address Approve and pay sends to, never cut (P1)", () => {
    const html = card();
    const line = html.slice(html.indexOf("Pays to"), html.indexOf(ADDRESS) + ADDRESS.length);
    expect(line).toContain(ADDRESS);
    const paragraph = html.slice(html.lastIndexOf("<p", html.indexOf("Pays to")), html.indexOf("Pays to"));
    expect(paragraph).toContain("break-all");
    expect(paragraph).not.toContain("truncate");
  });

  it("gives every decision a thumb-sized button, and Approve and pay the card's width (P2)", () => {
    const html = card();
    for (const name of ["Approve and pay", "Add details", "Reject", "Return to agent"]) {
      expect(classesOf(html, name), name).toContain("h-11");
      expect(classesOf(html, name), name).toContain("sm:h-8");
    }
    expect(classesOf(html, "Approve and pay")).toContain("max-sm:w-full");
  });
});

describe("Contractors on a phone", () => {
  it("sizes a held milestone's Pay now and Close without paying for a thumb (P2)", () => {
    const held = source("src/components/HeldMilestoneActions.tsx");
    expect(held).not.toMatch(/<Button size="sm"/);
    expect(held.match(/<Button size="touch"/g)).toHaveLength(2);
  });

  it("puts its counts two a row from the smallest width (P3)", () => {
    expect(source("src/app/o/[slug]/contractors/page.tsx")).toContain('className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4"');
  });

  it("wraps a row's second line, which carries its date, and the page's footer line (P4)", () => {
    expect(source("src/components/vx/DecisionRows.tsx")).toContain("block truncate text-xs text-ink-3 max-sm:whitespace-normal");
    expect(source("src/components/vx/Shell.tsx")).toContain("max-sm:whitespace-normal");
  });
});
