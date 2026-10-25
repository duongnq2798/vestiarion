import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard from "@/components/ApprovalCard";
import { HeldMilestoneActions } from "@/components/HeldMilestoneActions";
import { StatTile } from "@/components/vx/StatTile";
import { buttonVariants } from "@/components/ui/Button";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WaitingPayable } from "@/lib/agent/approvals";
import type { HeldReason } from "@/lib/agent/milestone-decisions";

/**
 * Decide from a phone (docs/superpowers/specs/2026-10-21-decide-from-a-phone-design.md P1-P4): Approvals and
 * Contractors at 375px show the whole address a payment goes to, give each decision a thumb-sized button below 640px
 * and leave it as it was above, and wrap what was cut.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/milestones", () => ({ payHeldMilestoneAction: vi.fn(), closeMilestoneAction: vi.fn() }));
vi.mock("@/app/actions/document-requests", () => ({ revokeDocumentRequestAction: vi.fn(), setDocumentRequestsAction: vi.fn(), attachDocumentAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(), cosignInvoiceAction: vi.fn(),
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

/** `sm`'s own classes, which `touch` must give from 640px up so nothing changes on a wider screen. */
const SM = ["h-8", "rounded-lg", "px-3", "text-xs", "[&_svg]:size-3.5"];

describe("the touch size (P2)", () => {
  it("is exactly sm from 640px up", () => {
    const sm = buttonVariants({ size: "sm" }).split(" ");
    const touch = buttonVariants({ size: "touch" }).split(" ");
    for (const name of SM) {
      expect(sm, name).toContain(name);
      expect(touch, `sm:${name}`).toContain(`sm:${name}`);
    }
  });

  it("is md's 44px below it", () => {
    expect(buttonVariants({ size: "touch" }).split(" ")).toEqual(expect.arrayContaining(["h-11", "rounded-xl", "px-4", "text-sm"]));
  });
});

describe("the approval card on a phone", () => {
  it("shows the whole address Approve and pay sends to, never cut (P1)", () => {
    const html = card();
    const line = html.slice(html.indexOf("Pays to"), html.indexOf(ADDRESS) + ADDRESS.length);
    expect(line).toContain(ADDRESS);
    const paragraph = html.slice(html.lastIndexOf("<p", html.indexOf("Pays to")), html.indexOf("Pays to"));
    expect(paragraph).not.toContain("truncate");
    // Only the address breaks anywhere; "Pays to" and a chain's name break as words.
    expect(paragraph).not.toContain("break-all");
    expect(html.slice(html.lastIndexOf("<span", html.indexOf(ADDRESS)), html.indexOf(ADDRESS))).toContain("break-all");
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
  it("sizes a held milestone's Pay now and Close without paying for a thumb, Pay now across the row (P2)", () => {
    const reason: HeldReason = {
      kind: "transfer_failed",
      hint: "Circle did not send it",
      text: "Circle did not send it. Pay now sends it again.",
      link: null,
      canPay: true,
      canClose: true,
      override: false,
    };
    const html = renderToStaticMarkup(
      <HeldMilestoneActions
        orgSlug="acme"
        milestone={{ id: "m-1", title: "Clean service", amount: 0.3, contractorName: "Puka Hotel" }}
        reason={reason}
        canDecide
        selfAdded={false}
        sandbox={false}
        soleApprover={false}
      />
    );
    for (const name of ["Pay now", "Close without paying"]) {
      expect(classesOf(html, name), name).toContain("h-11");
      expect(classesOf(html, name), name).toContain("sm:h-8");
    }
    expect(classesOf(html, "Pay now")).toContain("max-sm:w-full");
  });

  it("gives what needs you, and what was paid, a row each on a phone, the two counts side by side between (P3)", () => {
    const page = source("src/app/o/[slug]/contractors/page.tsx");
    expect(page).toContain('className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4"');
    expect(page.match(/className="max-sm:col-span-2"/g)).toHaveLength(2);
    const paidAt = page.indexOf('label="Paid"');
    expect(page.slice(paidAt, page.indexOf(">", paidAt))).toContain("max-sm:col-span-2");
    // The tile takes its place in the grid.
    expect(renderToStaticMarkup(<StatTile label="Paid" className="max-sm:col-span-2">1</StatTile>)).toContain("max-sm:col-span-2");
  });

  it("wraps a row's second line to two lines at most, its date whole, and the page's footer line (P4)", () => {
    const rows = source("src/components/vx/DecisionRows.tsx");
    expect(rows).toContain("block truncate text-xs text-ink-3 max-sm:line-clamp-2 max-sm:whitespace-normal");
    expect(rows).toContain('cn("whitespace-nowrap sm:hidden"');
    expect(source("src/components/vx/Shell.tsx")).toContain(
      '<Badge size="sm" className="bg-surface/80 font-mono font-normal text-ink-3 max-sm:justify-center max-sm:rounded-xl max-sm:text-center max-sm:whitespace-normal">'
    );
  });
});

describe("a verdict in shadow mode on a phone (P2)", () => {
  it("is given with thumb-sized buttons on Approvals, and stays small elsewhere", () => {
    const card = source("src/components/ApprovalCard.tsx");
    expect(card.match(/<VerdictControl [^>]*size="touch" \/>/g)).toHaveLength(2);
    const control = source("src/components/VerdictControl.tsx");
    expect(control).toContain('size = "sm"');
    expect(control).not.toMatch(/<Button size="sm"/);
  });
});
