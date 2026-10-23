// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitingPayable } from "@/lib/agent/approvals";
import type { DocumentRequestView } from "@/lib/document-requests/rules";

/**
 * What a bill's card says of the agent's request to its vendor (docs/superpowers/specs/2026-10-23-document-requests-design.md
 * ER3, ER4, ER6), on Approvals and on Bills, and the Settings section that turns it on (ER1): shadow's sentence, when it
 * asked and Revoke for an owner or admin, what the vendor sent with a members-only link and its purchase order filled into
 * Add details, and the setting's three choices for an owner.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(),
  cosignInvoiceAction: vi.fn(),
  rejectInvoiceAction: vi.fn(),
  returnInvoiceAction: vi.fn(),
  addInvoiceDetailsAction: vi.fn(),
}));
vi.mock("@/app/actions/document-requests", () => ({ revokeDocumentRequestAction: vi.fn(), setDocumentRequestsAction: vi.fn() }));

import ApprovalCard from "@/components/ApprovalCard";
import DocumentRequestsPanel, { documentRequestsSentence } from "@/components/DocumentRequestsPanel";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5";
const PAYABLE: WaitingPayable = {
  id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
  counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  counterpartyName: "Northstar Studio",
  riskLevel: "clear",
  amount: 1250,
  dueDate: "2026-10-30",
  status: "awaiting_info",
  reasoning: "No purchase order on file.",
  explanation: "No purchase order on file.",
  decidedAt: "2026-10-23T08:00:00.000Z",
  createdBy: null,
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x1948aB0000000000000000000000000000c345a0",
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "ARC-TESTNET",
  bridgeFeeUsdc: null,
  poReference: null,
  goodsReceived: true,
  addedSinceDecision: null,
  guardrailRule: null,
};

const ASKED: DocumentRequestView = { state: "asked", id: "2b6c1c9e-4a4f-4a7e-9b1e-0000000000d1", missing: ["purchase_order"], sentAt: "2026-10-23T09:00:00Z", expiresAt: "2026-11-06T09:00:00Z" };
const ANSWERED: DocumentRequestView = {
  state: "answered",
  id: "2b6c1c9e-4a4f-4a7e-9b1e-0000000000d1",
  missing: ["purchase_order"],
  answeredAt: "2026-10-24T15:00:00Z",
  poReference: "PO-4410",
  note: "Signed copy.",
  fileType: "application/pdf",
  fileSize: 2048,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function card(documentRequest: DocumentRequestView | undefined, canEdit = true) {
  act(() => {
    root.render(
      <TooltipProvider>
        <ApprovalCard orgSlug="pinecrest" payable={PAYABLE} canDecide viewerId={VIEWER} sandbox={false} canEdit={canEdit} documentRequest={documentRequest} />
      </TooltipProvider>
    );
  });
}

const buttonNamed = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) as HTMLButtonElement | undefined;

function openAddDetails(): HTMLElement {
  const button = buttonNamed("Add details", container);
  if (!button) throw new Error("no Add details button");
  act(() => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    button.click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Add details opened no dialog");
  return dialog;
}

describe("the card on Approvals (ER3, ER4, ER6)", () => {
  it("says when it asked and when the link expires, with Revoke for an owner or admin only", () => {
    card(ASKED);
    expect(container.textContent).toContain("Asked Northstar Studio for the purchase order on Oct 23; the link expires Nov 6.");
    expect(buttonNamed("Revoke", container)).toBeTruthy();
    card(ASKED, false);
    expect(buttonNamed("Revoke", container)).toBeUndefined();
  });

  it("says what the vendor sent, opens it for members, and fills its purchase order into Add details", () => {
    card(ANSWERED);
    expect(container.textContent).toContain("Northstar Studio sent a document on Oct 24.");
    expect(container.textContent).toContain("PO-4410");
    expect(container.textContent).toContain("Signed copy.");
    const open = [...container.querySelectorAll("a")].find((link) => link.textContent?.includes("Open the PDF"));
    expect(open?.getAttribute("href")).toBe("/api/document-requests/2b6c1c9e-4a4f-4a7e-9b1e-0000000000d1/file?org=pinecrest");
    const dialog = openAddDetails();
    const po = dialog.querySelector<HTMLInputElement>('input[name="poReference"]');
    expect(po?.value).toBe("PO-4410");
    expect(dialog.textContent).toContain("As Northstar Studio typed it with their document.");
  });

  it("says what Vestiarion would ask, in shadow, and nothing without a request", () => {
    card({ state: "would_ask", missing: ["purchase_order"] });
    expect(container.textContent).toContain("Vestiarion would ask Northstar Studio for the purchase order. Turn on vendor requests in Settings to send it.");
    card(undefined);
    expect(container.querySelector("[data-document-request]")).toBeNull();
    const dialog = openAddDetails();
    expect(dialog.querySelector<HTMLInputElement>('input[name="poReference"]')?.value).toBe("");
  });
});

describe("the card on Bills (ER3, ER6)", () => {
  const waiting = (documentRequest: DocumentRequestView | undefined, rights = true) =>
    renderToStaticMarkup(
      <WaitingPayableAction
        orgSlug="pinecrest"
        invoice={{ id: PAYABLE.id, counterpartyName: "Northstar Studio", counterpartyId: PAYABLE.counterpartyId, poReference: null, goodsReceived: true }}
        added={null}
        canAddDetails={rights}
        canDecide={rights}
        canFix={rights}
        documentRequest={documentRequest}
      />
    );

  it("shows the request above what a person can do", () => {
    const markup = waiting(ASKED);
    expect(markup).toContain("Asked Northstar Studio for the purchase order on Oct 23; the link expires Nov 6.");
    expect(markup).toContain("Add details");
    expect(markup.indexOf("Asked Northstar Studio")).toBeLessThan(markup.indexOf("Add details"));
  });

  it("shows a viewer the request too, with nothing to act on", () => {
    const markup = waiting(ANSWERED, false);
    expect(markup).toContain("Northstar Studio sent a document on Oct 24.");
    expect(markup).not.toContain("Add details");
    expect(markup).not.toContain("Revoke");
    expect(waiting(undefined, false)).toBe("");
  });

  it("is read beside the cards on Approvals and Bills", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    expect(read("src/app/o/[slug]/approvals/page.tsx")).toContain("documentRequest={documentRequests.get(payable.id)}");
    expect(read("src/app/o/[slug]/invoices/page.tsx")).toContain("documentRequest={documentRequests.get(invoice.id)}");
  });
});

describe("the Settings section (ER1)", () => {
  const render = (props: Partial<Parameters<typeof DocumentRequestsPanel>[0]> = {}) =>
    renderToStaticMarkup(<DocumentRequestsPanel orgSlug="pinecrest" status={{ setting: "off", ready: true }} canChange={false} {...props} />);

  it("says what each setting does", () => {
    expect(documentRequestsSentence("off")).toBe("Off: Vestiarion does not ask vendors for missing documents.");
    expect(documentRequestsSentence("shadow")).toBe("Shadow: each waiting bill's card says what Vestiarion would ask its vendor, and nothing is sent.");
    expect(documentRequestsSentence("on")).toBe(
      "On: when a bill waits for its purchase order or goods receipt, Vestiarion emails the vendor's billing address a link to send it."
    );
  });

  it("is beside the payee lock, under its own title, offering an owner the three choices", () => {
    const owner = render({ canChange: true, status: { setting: "shadow", ready: true } });
    expect(owner).toContain("Ask vendors for missing documents");
    for (const label of ["Off", "Shadow", "On"]) expect(owner).toContain(`>${label}<`);
    expect(owner).toContain('href="/docs/guides/first-payment#ask-the-vendor-for-a-missing-document"');
    const viewer = render();
    expect(viewer).not.toContain(">Shadow<");
    expect(viewer).toContain("An owner of this workspace can change it.");
    const settings = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/settings/page.tsx"), "utf8");
    expect(settings.indexOf('id: "document-requests-title"')).toBeGreaterThan(settings.indexOf('id: "payee-lock-title"'));
    expect(settings.indexOf('id: "document-requests-title"')).toBeLessThan(settings.indexOf('id: "ledger-key-title"'));
  });

  it("says it is not available before the workspace's database has it", () => {
    const markup = render({ canChange: true, status: { setting: "off", ready: false } });
    expect(markup).toContain("Not available in this workspace yet.");
    expect(markup).not.toContain(">Shadow<");
  });
});
