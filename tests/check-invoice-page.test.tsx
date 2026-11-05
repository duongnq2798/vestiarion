// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRY_HREF } from "@/components/landing/cta";
import { InvoiceChecker, SETTLE_MS } from "@/components/invoice-check/InvoiceChecker";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";

/**
 * /check-invoice (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC1, IC2, IC5, IC6, IC8-IC10): the free
 * invoice details check, rendered in a DOM and driven with its example and typed fields, and the page around it:
 * static, public, linked from the other tools, and with nothing that could send what is typed anywhere.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/check-invoice", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<InvoiceChecker sanctioned={sanctioned} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";
const live = () => container.querySelector('[aria-live="polite"][data-results]')?.textContent?.replace(/\s+/g, " ") ?? "";

function click(label: string) {
  const found = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  act(() => found.click());
}

/** The input labelled "<side>: <field>", as a screen reader names it. */
function input(side: "On file" | "On this invoice", field: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((each) => each.textContent?.replace(/\s+/g, " ").trim() === `${side}: ${field}`);
  if (!label) throw new Error(`no field ${side}: ${field}`);
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
}

function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Lets the typing pause long enough for the check to read it. */
const settle = () => act(() => vi.advanceTimersByTime(SETTLE_MS + 50));

describe("the checker (IC2, IC5, IC6)", () => {
  it("shows nothing until something is typed, and names every field on both sides for a screen reader", () => {
    expect(live()).toBe("");
    expect(text()).not.toContain("The call to make before you pay");
    for (const field of ["Vendor name", "Email it came from", "Phone", "Wallet address", "IBAN", "Account number", "Routing or sort code", "SWIFT / BIC", "Bank name"]) {
      expect(input("On file", field)).toBeTruthy();
      expect(input("On this invoice", field)).toBeTruthy();
    }
  });

  it("checks the example: a stop for the changed bank account, the pressure in the message, the wallet digit by digit and the call script", () => {
    click("Try an example");
    expect(live()).toContain("Do not pay yet: the bank account is not the one on file");
    expect(live()).toContain("The message also presses you to pay quickly and asks you not to call");
    expect(text()).toContain("Stop: The wallet address is made to look like the one on file.");
    expect(text()).toContain("Look: The message gives a reason for new details.");
    expect(text()).toContain("The wallet on the invoice");
    expect(text()).toContain("What was compared");
    expect(text()).toContain("LT35 3250 0123 4567 8901");
    expect(text()).toContain("The call to make before you pay");
    expect(text()).toContain("Call +44 20 7946 0958, the number you already had.");
    expect(text()).toContain("a new bank account and wallet address");
    click("Clear");
    expect(live()).toBe("");
    expect(input("On file", "IBAN").value).toBe("");
    expect(document.activeElement).toBe(input("On file", "Vendor name"));
  });

  it("waits for typing to pause, then says what it found, from a fix to nothing found", () => {
    type(input("On this invoice", "IBAN"), "GB82 WEST 1234 5698 7654 33");
    expect(live()).toBe("");
    settle();
    expect(live()).toContain("Check what you typed: the IBAN cannot be right as written");
    expect(text()).not.toContain("The call to make before you pay");
    type(input("On this invoice", "IBAN"), "GB82 WEST 1234 5698 7654 32");
    settle();
    expect(live()).toContain("Nothing on file to compare with");
    type(input("On file", "IBAN"), "GB82WEST12345698765432");
    settle();
    expect(live()).toContain("Nothing found");
    expect(live()).toContain("The 1 detail filled in on both sides matches.");
    type(input("On file", "IBAN"), "DE89 3704 0044 0532 0130 00");
    settle();
    expect(live()).toContain("Do not pay yet: the bank account is not the one on file");
    expect(text()).toContain("a new bank account. Did you make that change?");
  });

  it("makes no request and touches no cookie or storage while it checks (IC8)", () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const opened = vi.spyOn(XMLHttpRequest.prototype, "open");
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const cookie = document.cookie;
    click("Try an example");
    type(input("On this invoice", "Wallet address"), "0x1111111111111111111111111111111111111111");
    settle();
    expect(live()).toContain("Do not pay yet");
    expect(fetched).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
  });
});

describe("the page (IC1, IC8-IC10)", () => {
  it("is static and public, with its own title, canonical address, cards and heading, and not under /tools", async () => {
    const page = source("src/app/check-invoice/page.tsx");
    expect(page).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: CheckInvoicePage } = await import("@/app/check-invoice/page");
    expect(metadata).toMatchObject({
      title: "Invoice payment details check, free",
      alternates: { canonical: "/check-invoice" },
      openGraph: { url: "/check-invoice" },
      twitter: { card: "summary_large_image" },
    });
    expect(String(metadata.description)).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
    const markup = renderToStaticMarkup(<CheckInvoicePage />).replaceAll("&#x27;", "'");
    expect(markup).toMatch(/<h1[^>]*>Check an invoice's payment details before you pay it<\/h1>/);
    expect(markup).toContain(`href="${TRY_HREF}"`);
    expect(markup).toContain('data-cta="check-invoice-start"');
    expect(markup).toContain('href="/docs/guides/first-payment#payee-lock"');
    expect(markup).toContain('href="/check-address"');
    expect(markup).toContain('href="/check-vendor"');
  });

  it("is linked from the address checker and the payout batch check, and watched by the production check (IC1, IC10)", () => {
    expect(source("src/app/check-address/page.tsx")).toContain('href="/check-invoice"');
    expect(source("src/app/check-payouts/page.tsx")).toContain('href="/check-invoice"');
    const check = source("scripts/synthetic-check.mjs");
    expect(check).toContain('path: "/check-invoice"');
    expect(check).toContain('"/check-invoice</loc>"');
  });

  it("sends nothing anywhere: the checker, its rules and the page make no request, and read or write no address bar, storage or cookie (IC8)", () => {
    const files = [
      "src/components/invoice-check/InvoiceChecker.tsx",
      "src/lib/invoice-check/bank.ts",
      "src/lib/invoice-check/domain.ts",
      "src/lib/invoice-check/message.ts",
      "src/lib/invoice-check/findings.ts",
      "src/lib/invoice-check/call-script.ts",
      "src/lib/invoice-check/sample.ts",
      "src/app/check-invoice/page.tsx",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|useParams|URLSearchParams|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=|href=\{/
      );
    }
    for (const file of files.filter((each) => each.startsWith("src/components/") || each.startsWith("src/app/"))) {
      expect(source(file), file).not.toMatch(/\bVND\b|\b(?:safe|cleared|verified|compliant)\b/);
    }
    expect(source("src/app/check-invoice/page.tsx")).not.toContain("data-cta");
    for (const file of files.filter((each) => !each.startsWith("src/app/"))) expect(source(file), file).not.toMatch(/ToolCta|ToolStartLink|free-tools/);
  });
});
