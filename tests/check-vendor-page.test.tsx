// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRY_HREF } from "@/components/landing/cta";
import { loadNameIndex } from "@/components/vendor-check/load-index";
import { VendorChecker } from "@/components/vendor-check/VendorChecker";

/**
 * /check-vendor (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV7-CV9): the free vendor check, rendered in
 * a DOM and typed into, and the page around it: static, public, with its coverage stated, and with nothing that could
 * send what is typed or pasted anywhere.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/check-vendor", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const CHECKER_FILES = [
  "src/components/vendor-check/VendorChecker.tsx",
  "src/components/vendor-check/load-index.ts",
  "src/lib/vendor-check/match.ts",
  "src/lib/vendor-check/list.ts",
  "src/app/check-vendor/page.tsx",
];

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // The snapshot is loaded once, as the page's first check loads it.
  await loadNameIndex();
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<VendorChecker listDate="Oct 28, 2026" listDay="2026-10-28" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const live = (which = "for one name") => container.querySelector(`section[aria-label="What the check found ${which}"] [aria-live="polite"]`);
const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";

function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

/** Clicks, and lets a check that waits on the list finish before React draws its result. */
async function settle(action: () => void) {
  await act(async () => {
    action();
    await loadNameIndex();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const click = (label: string) => settle(() => button(label).click());

const field = (label: string) => document.getElementById([...container.querySelectorAll("label")].find((each) => each.textContent?.startsWith(label))!.htmlFor) as HTMLInputElement;

describe("one name (CV7)", () => {
  it("says nothing until a check runs, and has no form that could submit what is typed", () => {
    expect(text()).not.toContain("match in OFAC");
    expect(container.querySelector("form")).toBeNull();
    for (const control of container.querySelectorAll("input:not([type=file]), textarea")) {
      expect(control.getAttribute("autocomplete")).toBe("off");
      expect(control.hasAttribute("name")).toBe(false);
      // 16 px on a phone, so the browser does not zoom into the field.
      expect(control.className).toContain("text-base");
    }
  });

  it("shows a strong match with why it matched, its programs and other names, and a link to Treasury's search", async () => {
    type(field("Vendor name"), "Bank Melli Iran");
    type(field("Country"), "IR");
    await click("Check this name");
    expect(live()?.textContent).toContain("Strong match: review it before you pay");
    // Only the headline is announced, not each match under it.
    expect(live()?.textContent).not.toContain("Other names");
    expect(text()).toContain("BANK MELLI IRAN");
    expect(text()).toContain("Entity · IRAN, SDGT, IFSR");
    expect(text()).toContain("Score 1.00");
    expect(text()).toContain("Matched its name: bank, melli and iran are the same words.");
    expect(text()).toContain("The country agrees: Iran.");
    expect(text()).toContain("Other names: BANK MELLI, MELLI BANK, NATIONAL BANK OF IRAN");
    const link = container.querySelector('a[href="https://sanctionssearch.ofac.treas.gov/Details.aspx?id=25578"]');
    expect(link?.textContent).toContain("Check it on Treasury's search");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noreferrer");
  });

  it("says plainly when a name finds nothing, with the list's date", async () => {
    type(field("Vendor name"), "Northwind Design");
    await click("Check this name");
    expect(live()?.textContent).toContain("No match in OFAC's SDN list as of Oct 28, 2026.");
    expect(text()).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
  });

  it("checks on Enter too", async () => {
    type(field("Vendor name"), "Hezbollah");
    await settle(() => field("Vendor name").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(text()).toContain("HIZBALLAH");
    expect(text()).toContain("hezbollah is spelled another way as hizballah");
  });
});

describe("a list (CV6, CV7)", () => {
  it("checks the example list, counts it, names a lookalike wallet's other row, and downloads the results", async () => {
    await click("Try an example");
    expect(text()).toContain("Which column is which");
    expect(text()).toContain("5 rows, 3 columns.");
    await click("Check the list");
    expect(live("in the list")?.textContent).toContain("5 rows checked: 1 strong match, 0 possible matches, 4 with no match. 2 wallets to look at.");
    expect(text()).toContain("BANK MELLI IRAN");
    expect(text()).toContain("Do not pay: made to look like Northwind Design's address.");
    expect(text()).toContain("2 rows with no match in OFAC's SDN list as of Oct 28, 2026");

    let saved: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      saved = blob as Blob;
      return "blob:results";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await click("Download the results (CSV)");
    expect(clicked).toHaveBeenCalledOnce();
    const csv = await saved!.text();
    expect(csv).toContain("OFAC SDN result,Possible matches,Wallet result,SDN list as of");
    expect(csv).toContain("Strong match");
  });

  it("says why a list cannot be read", async () => {
    type(container.querySelector("textarea")!, '"never closed');
    await click("Read the list");
    expect(text()).toContain("A quoted field is never closed.");
  });
});

describe("the page (CV8, CV9)", () => {
  it("is static and public, with its own title, canonical address and cards, and not under /tools", async () => {
    const page = source("src/app/check-vendor/page.tsx");
    expect(page).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: CheckVendorPage } = await import("@/app/check-vendor/page");
    expect(metadata).toMatchObject({
      title: "OFAC check for vendors: one name or a whole list, free",
      alternates: { canonical: "/check-vendor" },
      openGraph: { url: "/check-vendor" },
    });
    const markup = renderToStaticMarkup(<CheckVendorPage />);
    expect(markup).toContain("Check your vendors against OFAC&#x27;s sanctions list");
    expect(markup).toContain("Nothing you type or paste is sent anywhere or kept.");
    expect(markup).toContain("What this check covers, and what it does not");
    expect(markup).toContain("OFAC&#x27;s SDN list only");
    expect(markup).toContain("not a compliance decision");
    expect(markup).toContain('href="https://sanctionssearch.ofac.treas.gov/"');
    const { requiresSession } = await import("@/lib/auth/routes");
    expect(requiresSession("/check-vendor")).toBe(false);
  });

  it("ends with the call to action, in one file a shared one can replace", async () => {
    const { default: CheckVendorPage } = await import("@/app/check-vendor/page");
    const markup = renderToStaticMarkup(<CheckVendorPage />);
    expect(markup).toContain(`href="${TRY_HREF.replace("&", "&amp;")}"`);
    expect(markup).toContain('data-cta="check-vendor-start"');
    expect(markup).toContain("Try it on your bills");
    expect(markup).toContain("In shadow mode it decides on your real bills while you keep paying them as you do now.");
    expect(source("src/components/vendor-check/VendorCheckCta.tsx")).toContain('data-cta="check-vendor-start"');
  });

  it("sends nothing anywhere: the checker and its rules make no request and read no address bar or storage", () => {
    for (const file of CHECKER_FILES) {
      const code = source(file);
      expect(code, file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=/
      );
    }
    // The snapshot is the one thing the checker loads, and it loads it from the site's own bundle.
    expect(source("src/components/vendor-check/load-index.ts")).toMatch(/import\("@\/lib\/data\/ofac-sdn-names\.json"\)/);
  });

  it("never calls a result safe, cleared, verified or compliant", () => {
    for (const file of CHECKER_FILES) expect(source(file), file).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
  });
});
