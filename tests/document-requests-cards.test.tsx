// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitingPayable } from "@/lib/agent/approvals";
import type { DocumentCheckView, DocumentRequestView } from "@/lib/document-requests/rules";

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
vi.mock("@/app/actions/document-requests", () => ({ revokeDocumentRequestAction: vi.fn(), setDocumentRequestsAction: vi.fn(), attachDocumentAction: vi.fn() }));

import ApprovalCard from "@/components/ApprovalCard";
import DocumentRequestsPanel, { documentRequestsSentence } from "@/components/DocumentRequestsPanel";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import { ruleNextStep, VENDOR_DOCUMENT } from "@/lib/next-step";
import { ruleLabel } from "@/lib/rule-words";

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

  it("keeps what the vendor sent, its file and its purchase order, beside a newer request", () => {
    card({ ...ASKED, sentAt: "2026-10-31T09:00:00Z", expiresAt: "2026-11-14T09:00:00Z", received: ANSWERED as Extract<DocumentRequestView, { state: "answered" }> });
    expect(container.textContent).toContain("Asked Northstar Studio for the purchase order on Oct 31; the link expires Nov 14.");
    expect(container.textContent).toContain("Northstar Studio sent a document on Oct 24.");
    expect(buttonNamed("Revoke", container)).toBeTruthy();
    const open = [...container.querySelectorAll("a")].find((link) => link.textContent?.includes("Open the PDF"));
    expect(open?.getAttribute("href")).toBe("/api/document-requests/2b6c1c9e-4a4f-4a7e-9b1e-0000000000d1/file?org=pinecrest");
    const dialog = openAddDetails();
    expect(dialog.querySelector<HTMLInputElement>('input[name="poReference"]')?.value).toBe("PO-4410");
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

  it("fills in the purchase order a vendor sent with an earlier request", () => {
    const view: DocumentRequestView = { state: "would_ask", missing: ["purchase_order"], received: ANSWERED as Extract<DocumentRequestView, { state: "answered" }> };
    act(() => {
      root.render(
        <TooltipProvider>
          <WaitingPayableAction
            orgSlug="pinecrest"
            invoice={{ id: PAYABLE.id, counterpartyName: "Northstar Studio", counterpartyId: PAYABLE.counterpartyId, poReference: null, goodsReceived: true }}
            added={null}
            canAddDetails
            canDecide
            canFix
            documentRequest={view}
          />
        </TooltipProvider>
      );
    });
    expect(container.textContent).toContain("Vestiarion would ask Northstar Studio for the purchase order.");
    expect(container.textContent).toContain("Northstar Studio sent a document on Oct 24.");
    expect(container.textContent).toContain("Open the PDF");
    const dialog = openAddDetails();
    expect(dialog.querySelector<HTMLInputElement>('input[name="poReference"]')?.value).toBe("PO-4410");
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

describe("what the check found, on Approvals and on Bills (document checks DK13)", () => {
  const checked = (check: DocumentCheckView, over: Partial<Extract<DocumentRequestView, { state: "answered" }>> = {}): DocumentRequestView => ({
    ...(ANSWERED as Extract<DocumentRequestView, { state: "answered" }>),
    source: "vendor",
    check,
    ...over,
  });
  const ADDED: DocumentCheckView = { outcome: "matched", po: "PO-2215", added: true, shadowLeftPo: false };
  const LINES: Array<[string, DocumentCheckView, boolean, string]> = [
    ["pending", { outcome: "pending" }, true, "Vestiarion checks it against the bill at its next cycle, usually within a minute."],
    [
      "matched",
      ADDED,
      true,
      "Vendor, amount and purchase order PO-2215 match the bill. Vestiarion added the purchase order and checked the bill again. A person approves the payment: the agent does not pay it on its own.",
    ],
    [
      "matched",
      ADDED,
      false,
      "Vendor, amount and purchase order PO-2215 match the bill. Vestiarion added the purchase order. Only your team can mark the goods received: do it in Add details once you have them, and a person then approves the payment.",
    ],
    [
      "matched",
      { outcome: "matched", po: "PO-2215", added: false, shadowLeftPo: true },
      true,
      "Vendor, amount and purchase order PO-2215 match the bill. Vendor requests are in shadow, so the bill was left as it is: add the purchase order yourself.",
    ],
    [
      "matched",
      { outcome: "matched", po: null, added: false, shadowLeftPo: false },
      false,
      "Vendor and amount match the bill. Only your team can mark the goods received: do it in Add details once you have them.",
    ],
    [
      "mismatched",
      { outcome: "mismatched", reason: "The document says 8.50 USDC; the bill says 8.00 USDC." },
      true,
      "The document says 8.50 USDC; the bill says 8.00 USDC. The bill still waits: check it with Northstar Studio, or add the details yourself.",
    ],
    [
      "unreadable",
      { outcome: "unreadable", reason: "It is a PDF with no text to read, such as a scan." },
      true,
      "Vestiarion could not check it. It is a PDF with no text to read, such as a scan. Open it, and add the details yourself.",
    ],
    ["skipped", { outcome: "skipped", reason: "It was not checked: the bill no longer waited for a document." }, true, "It was not checked: the bill no longer waited for a document."],
  ];

  it("says each check's line on Approvals, as the bill's goods stand now", () => {
    for (const [outcome, check, goodsReceived, line] of LINES) {
      act(() => {
        root.render(
          <TooltipProvider>
            <ApprovalCard orgSlug="pinecrest" payable={{ ...PAYABLE, goodsReceived }} canDecide viewerId={VIEWER} sandbox={false} canEdit documentRequest={checked(check)} />
          </TooltipProvider>
        );
      });
      const shown = container.querySelector(`[data-document-check="${outcome}"]`);
      expect(shown?.textContent, line).toBe(line);
    }
  });

  it("says each check's line on Bills, under the document's headline", () => {
    for (const [outcome, check, goodsReceived, line] of LINES) {
      const markup = renderToStaticMarkup(
        <WaitingPayableAction
          orgSlug="pinecrest"
          invoice={{ id: PAYABLE.id, counterpartyName: "Northstar Studio", counterpartyId: PAYABLE.counterpartyId, poReference: null, goodsReceived }}
          added={null}
          canAddDetails
          canDecide
          canFix
          documentRequest={checked(check)}
        />
      );
      expect(markup, line).toContain(`data-document-check="${outcome}"`);
      expect(markup.indexOf("Northstar Studio sent a document on Oct 24.")).toBeLessThan(markup.indexOf(`data-document-check="${outcome}"`));
    }
  });

  it("names a member who attached the vendor's document", () => {
    card(checked({ outcome: "pending" }, { source: "member", poReference: null, note: null, answeredAt: "2026-10-25T08:00:00Z" }));
    expect(container.textContent).toContain("A member attached Northstar Studio's document on Oct 25.");
    expect(container.textContent).not.toContain("Purchase order they typed");
  });

  it("says nothing of a check where none was read: before migration 0144, or while vendor requests are off", () => {
    card(ANSWERED);
    expect(container.querySelector("[data-document-check]")).toBeNull();
    expect(container.textContent).toContain("Northstar Studio sent a document on Oct 24.");
  });

  it("says the check found by an earlier answer, beside a newer request", () => {
    card({ ...ASKED, sentAt: "2026-10-31T09:00:00Z", expiresAt: "2026-11-14T09:00:00Z", received: checked(ADDED) as Extract<DocumentRequestView, { state: "answered" }> });
    expect(container.querySelector('[data-document-received] [data-document-check="matched"]')?.textContent).toContain("Vestiarion added the purchase order");
  });
});

describe("Attach a document (document checks DK11)", () => {
  const approvals = (over: { canEdit?: boolean; documentChecks?: "shadow" | "on" | null; payable?: Partial<typeof PAYABLE> } = {}) => {
    act(() => {
      root.render(
        <TooltipProvider>
          <ApprovalCard
            orgSlug="pinecrest"
            payable={{ ...PAYABLE, ...over.payable }}
            canDecide
            viewerId={VIEWER}
            sandbox={false}
            canEdit={over.canEdit ?? true}
            documentChecks={over.documentChecks === undefined ? "on" : over.documentChecks}
          />
        </TooltipProvider>
      );
    });
  };

  function openAttach(): HTMLElement {
    const button = buttonNamed("Attach a document", container);
    if (!button) throw new Error("no Attach a document button");
    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      button.click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("Attach a document opened no dialog");
    return dialog;
  }

  it("offers an owner or admin the vendor's PDF on a bill waiting for its purchase order, and says what the check does when on", () => {
    approvals();
    expect(buttonNamed("Add details", container)).toBeTruthy();
    const dialog = openAttach();
    expect(dialog.textContent).toContain("Attach Northstar Studio's document");
    expect(dialog.textContent).toContain(
      "Choose the PDF Northstar Studio sent you, such as their purchase order, of up to 4 MB. Vestiarion checks its vendor, amount and purchase order against the bill. When they match, it adds the purchase order, and a person approves the payment."
    );
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.getAttribute("name")).toBe("file");
    expect(input?.getAttribute("accept")).toBe("application/pdf");
    expect(dialog.textContent).toContain("PDF");
    expect(buttonNamed("Cancel", dialog)).toBeTruthy();
    expect(buttonNamed("Attach and check", dialog)?.disabled).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>('input[name="invoiceId"]')?.value).toBe(PAYABLE.id);
  });

  it("says the bill does not change in shadow", () => {
    approvals({ documentChecks: "shadow" });
    expect(openAttach().textContent).toContain(
      "Choose the PDF Northstar Studio sent you, such as their purchase order, of up to 4 MB. Vestiarion checks its vendor, amount and purchase order against the bill and says what it found. Vendor requests are in shadow, so the bill does not change."
    );
  });

  it("is not offered to a viewer or approver, while off or before 0144, on a bill held for another reason, or one lacking nothing", () => {
    for (const over of [
      { canEdit: false },
      { documentChecks: null },
      { payable: { status: "held" as const } },
      { payable: { poReference: "PO-2215", goodsReceived: true } },
      { payable: { paymentSent: true } },
    ]) {
      approvals(over);
      expect(buttonNamed("Attach a document", container), JSON.stringify(over)).toBeUndefined();
    }
  });

  it("is not offered on a bill whose vendor is paid without purchase orders, with its goods received", () => {
    // Waiting for information, say on the model's own question: a purchase order is not what it lacks.
    approvals({ payable: { poReference: null, goodsReceived: true, purchaseOrderRequired: false } });
    expect(buttonNamed("Attach a document", container)).toBeUndefined();
    // The same vendor's bill still waiting for its goods receipt is offered it.
    approvals({ payable: { poReference: null, goodsReceived: false, purchaseOrderRequired: false } });
    expect(buttonNamed("Attach a document", container)).toBeTruthy();
    // With no word from the server, a purchase order is needed, as the server reads it.
    approvals({ payable: { poReference: null, goodsReceived: true } });
    expect(buttonNamed("Attach a document", container)).toBeTruthy();
  });

  it("is offered on Bills beside Add details, only on a bill that waits for information", () => {
    const bills = (status: string | undefined, documentChecks: "shadow" | "on" | null = "on", rights = true) =>
      renderToStaticMarkup(
        <WaitingPayableAction
          orgSlug="pinecrest"
          invoice={{ id: PAYABLE.id, counterpartyName: "Northstar Studio", counterpartyId: PAYABLE.counterpartyId, status, poReference: null, goodsReceived: true }}
          added={null}
          canAddDetails={rights}
          canDecide={rights}
          canFix={rights}
          documentChecks={documentChecks}
        />
      );
    const markup = bills("awaiting_info");
    expect(markup).toContain("Attach a document");
    expect(markup.indexOf("Add details")).toBeLessThan(markup.indexOf("Attach a document"));
    expect(bills("held")).not.toContain("Attach a document");
    expect(bills(undefined)).not.toContain("Attach a document");
    expect(bills("awaiting_info", null)).not.toContain("Attach a document");
    expect(bills("awaiting_info", "shadow", false)).not.toContain("Attach a document");
  });

  it("is read once on Approvals and Bills, beside the cards", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    for (const file of ["src/app/o/[slug]/approvals/page.tsx", "src/app/o/[slug]/invoices/page.tsx"]) {
      const page = read(file);
      expect(page.match(/readDocumentChecksStatus\(db\(\)\)/g), file).toHaveLength(1);
      expect(page).toContain("documentChecks={documentChecks}");
    }
  });

  it("names the rule that holds a bill the check completed, and what a person does next", () => {
    expect(ruleLabel(VENDOR_DOCUMENT)).toBe("Its purchase order came from a vendor's document, which a person approves");
    expect(ruleNextStep(VENDOR_DOCUMENT, { id: PAYABLE.counterpartyId, name: "Northstar Studio" })?.sentence).toBe(
      "Its purchase order came from Northstar Studio's document, which matched the bill. Check the document, then approve the payment in Approvals: the agent does not pay it on its own."
    );
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

  it("says what the check does once documents are checked, and part 1's copy before migration 0144 (document checks DK1)", () => {
    expect(documentRequestsSentence("shadow", true)).toBe(
      "Shadow: each waiting bill's card says what Vestiarion would ask its vendor and what it finds in a document. Nothing is sent, and no bill changes."
    );
    expect(documentRequestsSentence("on", true)).toBe(
      "On: Vestiarion emails the vendor's billing address a link to send the missing document, and checks what comes back against the bill."
    );
    expect(documentRequestsSentence("off", true)).toBe("Off: Vestiarion does not ask vendors for missing documents.");
    const checked = render({ canChange: true, status: { setting: "on", ready: true, checks: true } });
    expect(checked).toContain("and you can attach one they emailed you. Vestiarion checks its vendor, amount and purchase order against the bill.");
    expect(checked).toContain("The agent never pays a bill on its own because a document arrived.");
    expect(checked).toContain("Nothing is asked or checked. You chase vendors yourself, and add the details on the bill.");
    expect(checked).toContain("See which vendors Vestiarion would ask, and what it finds in a document, on each bill&#x27;s card. Nothing is sent, and no bill changes.");
    expect(checked).toContain(
      "Vestiarion emails the vendor once per bill, at most 20 a day, and the link works for 14 days. A document that matches the bill adds its purchase order, and a person approves the payment."
    );
    expect(checked).not.toContain("You still add the details");
    const before = render({ canChange: true, status: { setting: "on", ready: true, checks: false } });
    expect(before).toContain("You still add the details, and the agent decides the bill again. Nothing is paid because a document arrived.");
    expect(before).toContain("Vestiarion emails the vendor once per bill, at most 20 a day. The link works for 14 days.");
    expect(before).not.toContain("attach one they emailed you");
  });

  it("says it is not available before the workspace's database has it", () => {
    const markup = render({ canChange: true, status: { setting: "off", ready: false } });
    expect(markup).toContain("Not available in this workspace yet.");
    expect(markup).not.toContain(">Shadow<");
  });
});
