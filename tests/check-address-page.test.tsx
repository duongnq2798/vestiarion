// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressChecker, EXAMPLE_PAY } from "@/components/address-check/AddressChecker";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";

/**
 * /check-address (docs/superpowers/specs/2026-10-21-address-checker-design.md AC6, AC7): the free checker, rendered in a
 * DOM and typed into, and the page around it: static, public, and with nothing that could send what is pasted anywhere.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/check-address", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const KNOWN = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AddressChecker sanctioned={sanctioned} listDate="Oct 21, 2026" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";

function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button ${label}`);
  act(() => button.click());
}

describe("the checker (AC6)", () => {
  it("says nothing until something is pasted, and has no form that could submit it", () => {
    expect(text()).not.toContain("Do not pay");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")?.getAttribute("autocomplete")).toBe("off");
  });

  it("shows the example: an address made to look like Northwind Design's, its shared ends and how rare that is", () => {
    click("Try an example");
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(EXAMPLE_PAY);
    expect(text()).toContain("Do not pay: this address is made to look like Northwind Design's");
    expect(text()).toContain("Shares its first 4 and last 4 digits with Northwind Design's address, and differs in between.");
    expect(text()).toContain("about once in 4.3 billion");
    expect(text()).toContain("It is made to look like one of the 2 you know.");
    expect(text()).toContain("It is not among the 124 EVM addresses on OFAC's SDN list of Oct 21, 2026.");
    expect(text()).toContain("Read 2 addresses: Northwind Design (0x7a2d…e10d), Harbor Print Co (0x3f9e…b742).");
    // A differing digit is marked by more than its colour.
    expect(container.querySelector(".bg-refused-soft.font-semibold")).not.toBeNull();
    // The headline alone is announced as it changes.
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("Do not pay");
    expect(container.querySelector('[aria-live="polite"] li')).toBeNull();
    click("Clear");
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(text()).not.toContain("Do not pay");
  });

  it("says what is wrong while it is not an address yet, without announcing it at each keystroke", () => {
    type(container.querySelector("input")!, KNOWN.slice(0, 30));
    expect(text()).toContain("Not an address yet");
    expect(text()).toContain("It has 28 characters after 0x; an address has 40.");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("");
  });

  it("says when the list itself holds an address made to look like the one being paid", () => {
    type(container.querySelector("textarea")!, `Northwind, ${KNOWN}\nFrom history, 0x7a2d${"9".repeat(32)}e10d`);
    type(container.querySelector("input")!, KNOWN);
    expect(text()).toContain("It matches Northwind, but your list has an address made to look like it");
    expect(text()).toContain("From history's address shares its first 4 and last 4 digits with it.");
  });

  it("lists a line it could not read, and why", () => {
    type(container.querySelector("textarea")!, `Northwind, 0X${KNOWN.slice(2)}`);
    expect(text()).toContain("Line 1 was not read. An address starts with 0x, with a small x.");
  });

  it("notes a partial match without stopping", () => {
    type(container.querySelector("textarea")!, `Harbor, ${KNOWN}`);
    type(container.querySelector("input")!, `0x${"1".repeat(36)}e10d`);
    expect(text()).toContain("Nothing here says it is wrong");
    expect(text()).toContain("It shares its last 4 digits with Harbor's address. Compare the whole address.");
  });

  it("uses 16 px fields on a phone, so the browser does not zoom into them", () => {
    for (const control of container.querySelectorAll("input, textarea")) expect(control.className).toContain("text-base sm:text-[0.8125rem]");
  });

  it("says it is the address known, or that nothing says it is wrong", () => {
    type(container.querySelector("textarea")!, `Northwind, ${KNOWN}`);
    type(container.querySelector("input")!, KNOWN);
    expect(text()).toContain("It is the address you know as Northwind");
    expect(text()).toContain("it is the same wallet as in your list");
    type(container.querySelector("input")!, `0x${"12".repeat(20)}`);
    expect(text()).toContain("Nothing here says it is wrong");
    expect(text()).toContain("It is not made to look like any of the 1 you know.");
  });

  it("stops at an address on OFAC's list, naming its entry", () => {
    const [listed] = snapshot.wallets;
    type(container.querySelector("input")!, listed.address);
    expect(text()).toContain("Do not pay: this address is on OFAC's sanctions list");
    expect(text()).toContain(`OFAC lists it under ${listed.name}.`);
  });

  it("stops at a token contract", () => {
    type(container.querySelector("input")!, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(text()).toContain("Do not pay: this is not a wallet");
    expect(text()).toContain("This is the USDC on Base token contract, not a wallet.");
  });
});

describe("the page (AC7)", () => {
  it("is static and public, with its own canonical address and cards, and not under /tools", async () => {
    const page = source("src/app/check-address/page.tsx");
    expect(page).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: CheckAddressPage } = await import("@/app/check-address/page");
    expect(metadata).toMatchObject({ title: "Address lookalike checker", alternates: { canonical: "/check-address" } });
    const markup = renderToStaticMarkup(<CheckAddressPage />);
    expect(markup).toContain("Check an address before you pay it");
    expect(markup).toContain("Nothing you paste is sent anywhere or kept.");
    expect(markup).toContain('data-cta="check-address-start"');
    expect(markup).toContain('href="/docs/guides/first-payment#payee-lock"');
    const { requiresSession } = await import("@/lib/auth/routes");
    expect(requiresSession("/check-address")).toBe(false);
  });

  it("sends nothing anywhere: the checker and its rules make no request and read no address bar", () => {
    for (const file of ["src/components/address-check/AddressChecker.tsx", "src/lib/address-check.ts", "src/app/check-address/page.tsx"]) {
      const code = source(file);
      expect(code, file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=/
      );
    }
  });
});
