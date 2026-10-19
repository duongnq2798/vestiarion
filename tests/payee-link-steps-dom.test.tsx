// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PayeeAddressForm, { CHAIN_QUESTION, chainCheck, SEND_HINT_WITH_CHAIN } from "@/components/PayeeAddressForm";
import PayeeInvoiceForm from "@/components/payee/PayeeInvoiceForm";

/**
 * A payee link's new steps, rendered in a DOM (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P2, P4):
 * the chain chosen before the address, named in the field and in a fourth box, and sent with the address; the address
 * on file kept; and the invoice's fields sent, a refused field marked.
 */

const { actions } = vi.hoisted(() => ({
  actions: {
    address: vi.fn(async () => ({ ok: false, message: "" })),
    keep: vi.fn(async () => ({ ok: true, message: "Kept the address Acme has on file." })),
    invoice: vi.fn(async (): Promise<{ ok: boolean; message: string; field?: string }> => ({ ok: false, message: "" })),
  },
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/app/payee/[token]/actions", () => ({
  submitPayeeAddressAction: actions.address,
  keepPayeeAddressAction: actions.keep,
  submitPayeeInvoiceAction: actions.invoice,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = `vxp_${"A".repeat(43)}`;
const ADDRESS = "0x2222222222222222222222222222222222222222";
const CHAINS = [
  { id: "ARC", label: "Arc mainnet" },
  { id: "BASE", label: "Base" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockClear();
  refresh.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const buttonNamed = (name: string) => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) as HTMLButtonElement | undefined;

async function press(name: string) {
  const button = buttonNamed(name);
  if (!button) throw new Error(`no ${name} button`);
  await act(async () => {
    button.click();
  });
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const sent = (action: (typeof actions)[keyof typeof actions]) => (action.mock.calls[0] as unknown as [unknown, FormData] | undefined)?.[1];

describe("choosing the chain before the address (P2)", () => {
  it("names the chain chosen in the field and in a fourth box, and sends it with the address", async () => {
    act(() => root.render(<PayeeAddressForm token={TOKEN} orgName="Acme" chainLabel="Arc mainnet" chains={CHAINS} defaultChain="ARC" />));
    expect(container.textContent).toContain(CHAIN_QUESTION);
    expect(container.querySelector('input[name="address"]')).toBeNull();
    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    await act(async () => {
      radios[1].click();
    });
    await press("Continue");
    expect(container.textContent).toContain("Your wallet address on Base");

    type(container.querySelector<HTMLInputElement>('input[name="address"]') as HTMLInputElement, ADDRESS);
    await press("Continue");
    expect(container.textContent).toContain(chainCheck("Base"));
    expect(container.textContent).toContain("Before you send it, tick all four");
    expect(container.textContent).toContain(SEND_HINT_WITH_CHAIN);
    expect(container.querySelector<HTMLInputElement>('input[type="hidden"][name="chain"]')?.value).toBe("BASE");

    const boxes = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      await act(async () => {
        box.click();
      });
    }
    await press("Send my address");
    const data = sent(actions.address);
    expect(data?.get("chain")).toBe("BASE");
    expect(data?.get("address")).toBe(ADDRESS);
    expect(data?.get("token")).toBe(TOKEN);
  });

  it("sends no chain from a link that does not offer the choice, and asks for three boxes", async () => {
    act(() => root.render(<PayeeAddressForm token={TOKEN} orgName="Acme" chainLabel="Arc mainnet" />));
    type(container.querySelector<HTMLInputElement>('input[name="address"]') as HTMLInputElement, ADDRESS);
    await press("Continue");
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
    expect(container.querySelector('input[name="chain"]')).toBeNull();
  });
});

describe("keeping the address on file (P4)", () => {
  it("uses the link without an address, and refreshes into the invoice step", async () => {
    act(() => root.render(<PayeeAddressForm token={TOKEN} orgName="Acme" chainLabel="Arc mainnet" keep={{ masked: "0x2222…2222" }} />));
    expect(container.textContent).toContain("0x2222…2222");
    await press("Keep this address");
    expect(sent(actions.keep)?.get("token")).toBe(TOKEN);
    expect(container.textContent).toContain("Kept the address Acme has on file.");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("the invoice step (P4)", () => {
  function fill() {
    const field = (name: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`) as HTMLInputElement;
    type(field("invoiceNumber"), "INV-7");
    type(field("amount"), "1250.50");
    type(field("dueDate"), "2026-11-02");
    type(field("note"), "October");
  }

  it("sends the fields with the link's token", async () => {
    act(() => root.render(<PayeeInvoiceForm token={TOKEN} orgName="Acme" today="2026-10-19" lastDay="2027-10-19" />));
    const due = container.querySelector<HTMLInputElement>('input[name="dueDate"]');
    expect(due?.min).toBe("2026-10-19");
    expect(due?.max).toBe("2027-10-19");
    fill();
    await press("Send my invoice");
    const data = sent(actions.invoice);
    expect(Object.fromEntries([...(data?.entries() ?? [])].filter(([key]) => key !== "file"))).toEqual({
      token: TOKEN,
      invoiceNumber: "INV-7",
      amount: "1250.50",
      dueDate: "2026-11-02",
      note: "October",
    });
  });

  it("marks the field a refusal is about, and keeps what was typed", async () => {
    actions.invoice.mockResolvedValueOnce({ ok: false, message: "Choose a due date from today to a year from today.", field: "dueDate" });
    act(() => root.render(<PayeeInvoiceForm token={TOKEN} orgName="Acme" today="2026-10-19" lastDay="2027-10-19" />));
    fill();
    await press("Send my invoice");
    expect(container.querySelector('input[name="dueDate"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('input[name="amount"]')?.getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).toContain("Choose a due date from today to a year from today.");
    expect(container.querySelector<HTMLInputElement>('input[name="invoiceNumber"]')?.value).toBe("INV-7");
  });

  it("thanks the payee once it is sent, and refreshes into the next step", async () => {
    actions.invoice.mockResolvedValueOnce({ ok: true, message: "Sent. Acme reviews your invoice before adding it." });
    act(() => root.render(<PayeeInvoiceForm token={TOKEN} orgName="Acme" today="2026-10-19" lastDay="2027-10-19" />));
    fill();
    await press("Send my invoice");
    expect(container.textContent).toContain("Sent. Acme reviews your invoice before adding it.");
    expect(refresh).toHaveBeenCalled();
  });
});
