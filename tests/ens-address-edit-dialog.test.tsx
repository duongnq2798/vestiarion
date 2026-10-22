// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";

/**
 * The Edit address dialog with a name looked up in it (docs/superpowers/specs/2026-10-22-ens-address-names-design.md EN1):
 * an address put in the field and cancelled is not there when the dialog opens again, so it cannot pass for the address
 * on file.
 */

vi.mock("@/app/actions/policy-replay", () => ({ tryRuleAction: vi.fn() }));
vi.mock("@/app/actions/intake", () => ({
  updateCounterpartyAddressAction: vi.fn(),
  confirmCounterpartyAddressAction: vi.fn(),
  updateCounterpartyLimitAction: vi.fn(),
  lookupAddressNameAction: vi.fn(async () => ({ ok: true })),
}));

const ON_FILE = "0x2222222222222222222222222222222222222222";
const TYPED = "0x3333333333333333333333333333333333333333";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <CounterpartyAddress
        orgSlug="acme"
        counterparty={{ id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000c7", name: "Acme", address: ON_FILE }}
        unconfirmedSince={null}
        canWrite
        canConfirm={false}
      />
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button ${label}`);
  act(() => button.click());
}

const field = () => document.querySelector<HTMLInputElement>('input[name="address"]');

function type(control: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Edit address", () => {
  it("opens on the address on file again after a change was cancelled", () => {
    click("Edit address");
    expect(field()?.value).toBe(ON_FILE);
    type(field()!, TYPED);
    expect(field()?.value).toBe(TYPED);
    click("Cancel");
    expect(field()).toBeNull();
    click("Edit address");
    expect(field()?.value).toBe(ON_FILE);
  });
});
