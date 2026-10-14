// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalCard, { overridesHold, REASON_HINT } from "@/components/ApprovalCard";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WaitingPayable } from "@/lib/agent/approvals";

/**
 * Approvals asks why, in the moment (docs/superpowers/specs/2026-10-14-capability-and-reasons-design.md R10): Reject,
 * Return to agent and, on a payable the agent flagged or held on a rule, Approve and pay, each ask for a one-line reason
 * in their own dialog, optional and never blocking. Rendered in a DOM: the dialog is opened, a reason typed into it, and
 * the confirmation submits the card's form, whose data the action receives.
 */

const { actions } = vi.hoisted(() => {
  const answer = async () => ({ ok: true, message: "Done." });
  return { actions: { approve: vi.fn(answer), reject: vi.fn(answer), giveBack: vi.fn(answer), details: vi.fn(answer) } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: actions.approve,
  rejectInvoiceAction: actions.reject,
  returnInvoiceAction: actions.giveBack,
  addInvoiceDetailsAction: actions.details,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5";
const PAYABLE: WaitingPayable = {
  id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
  counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  counterpartyName: "Northwind Supply",
  riskLevel: "low",
  amount: 96.39,
  dueDate: "2026-10-10",
  status: "held",
  reasoning: "Above Northwind Supply's payment limit.",
  explanation: "Above Northwind Supply's payment limit.",
  decidedAt: "2026-10-07T10:00:00.000Z",
  createdBy: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1",
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
  guardrailRule: "counterparty_limit",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(payable: WaitingPayable = PAYABLE) {
  act(() => {
    root.render(
      <TooltipProvider>
        <ApprovalCard orgSlug="acme" payable={payable} canDecide viewerId={VIEWER} sandbox={false} />
      </TooltipProvider>
    );
  });
}

const buttonNamed = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) as HTMLButtonElement | undefined;

/** Opens a dialog by its trigger, and answers the dialog. */
function open(trigger: string): HTMLElement {
  const button = buttonNamed(trigger, container);
  if (!button) throw new Error(`no ${trigger} button`);
  act(() => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    button.click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
  if (!dialog) throw new Error(`${trigger} opened no dialog`);
  return dialog;
}

/** Types into a field as a person does: the value, then the input event React listens for. */
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const labelled = (dialog: HTMLElement, label: string) => {
  const forId = [...dialog.querySelectorAll("label")].find((element) => element.textContent?.includes(label))?.getAttribute("for");
  return forId ? (document.getElementById(forId) as HTMLInputElement | HTMLTextAreaElement | null) : null;
};

/**
 * Confirms the dialog as a person does, by pressing its button: the button sits in the dialog, outside the card's form,
 * and submits that form through its `form` attribute, while pressing it closes the dialog.
 */
async function confirm(dialog: HTMLElement, label: string) {
  const button = buttonNamed(label, dialog);
  if (!button) throw new Error(`no ${label} button in the dialog`);
  const formId = button.getAttribute("form");
  expect(formId, `${label} names the card's form`).toBeTruthy();
  expect(document.getElementById(formId as string)?.tagName).toBe("FORM");
  expect(dialog.contains(document.getElementById(formId as string))).toBe(false);
  await act(async () => {
    button.click();
  });
}

const sent = (action: (typeof actions)[keyof typeof actions]) => {
  const call = action.mock.calls[0] as unknown as [unknown, FormData] | undefined;
  return call?.[1];
};

describe("Approvals asks why, in the dialog, and the reason reaches the action", () => {
  it("Return to agent: asks why it is returned, and sends the reason typed with the form", async () => {
    render();
    const dialog = open("Return to agent");
    expect(dialog.textContent).toContain("Why return it?");
    expect(dialog.textContent).toContain(REASON_HINT);
    const field = labelled(dialog, "Why return it?");
    expect(field).not.toBeNull();
    expect(field?.required).toBe(false);
    type(field as HTMLInputElement, "Waiting on the corrected invoice");
    await confirm(dialog, "Return to agent");
    const data = sent(actions.giveBack);
    expect(data?.get("invoiceId")).toBe(PAYABLE.id);
    expect(data?.get("reason")).toBe("Waiting on the corrected invoice");
  });

  it("Return to agent without a reason still returns it: nothing waits on the field", async () => {
    render();
    await confirm(open("Return to agent"), "Return to agent");
    expect(actions.giveBack).toHaveBeenCalledTimes(1);
    expect(sent(actions.giveBack)?.get("reason")).toBe("");
  });

  it("Approve and pay on a bill the agent held on a rule: asks why it is paid anyway, and sends it", async () => {
    render();
    const dialog = open("Approve and pay");
    const field = labelled(dialog, "Why pay it anyway?");
    expect(field).not.toBeNull();
    type(field as HTMLInputElement, "Known supplier, limit raised next week");
    await confirm(dialog, "Pay now");
    const data = sent(actions.approve);
    expect(data?.get("reason")).toBe("Known supplier, limit raised next week");
    expect(data?.get("address")).toBe(PAYABLE.address);
  });

  it("Approve and pay on a bill held for cash: asks nothing, and sends no reason", async () => {
    render({ ...PAYABLE, guardrailRule: null, heldForCash: true });
    const dialog = open("Approve and pay");
    expect(dialog.textContent).not.toContain("Why pay it anyway?");
    await confirm(dialog, "Pay now");
    expect(actions.approve).toHaveBeenCalledTimes(1);
    expect(sent(actions.approve)?.has("reason")).toBe(false);
  });

  it("Approve and pay that checks an earlier transfer first asks nothing, since it sends nothing new (payment exceptions E3)", async () => {
    for (const payable of [
      { ...PAYABLE, lastAttempt: { state: "unanswered" as const } },
      { ...PAYABLE, paymentSent: true },
    ]) {
      render(payable);
      const dialog = open("Approve and pay");
      expect(dialog.textContent).not.toContain("Why pay it anyway?");
      expect(buttonNamed("Look first", dialog) ?? buttonNamed("Check it", dialog)).toBeDefined();
      await confirm(dialog, buttonNamed("Look first", dialog) ? "Look first" : "Check it");
      expect(sent(actions.approve)?.has("reason")).toBe(false);
      actions.approve.mockClear();
      act(() => root.render(<></>));
      document.querySelectorAll('[role="alertdialog"]').forEach((node) => node.remove());
    }
  });

  it("Reject: asks why it is rejected, optional, and sends the reason", async () => {
    render();
    const dialog = open("Reject");
    const field = labelled(dialog, "Why reject it?");
    expect(field).not.toBeNull();
    expect(field?.required).toBe(false);
    type(field as HTMLTextAreaElement, "Duplicate of INV-7");
    const submit = buttonNamed("Reject", dialog);
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.closest("form")?.requestSubmit(submit);
    });
    expect(sent(actions.reject)?.get("reason")).toBe("Duplicate of INV-7");
  });
});

describe("the action passes a reason on only when one was given", () => {
  it("drops an empty one", () => {
    const action = readFileSync(path.join(process.cwd(), "src/app/actions/approvals.ts"), "utf8");
    expect(action).toContain("return reason ? { reason } : {};");
  });
});

describe("where Approve and pay asks why", () => {
  it("only where it overrides the agent: flagged, or held on one of its rules", () => {
    const held = { status: "held" as const, guardrailRule: null, heldForCash: false, heldForVerdict: false };
    expect(overridesHold({ ...held, status: "flagged" })).toBe(true);
    expect(overridesHold({ ...held, guardrailRule: "counterparty_limit" })).toBe(true);
    expect(overridesHold(held)).toBe(false);
    expect(overridesHold({ ...held, guardrailRule: "counterparty_limit", heldForCash: true })).toBe(false);
    expect(overridesHold({ ...held, status: "flagged", heldForVerdict: true })).toBe(false);
  });
});
