// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { loadNameIndex } from "@/components/vendor-check/load-index";
import { VendorChecker } from "@/components/vendor-check/VendorChecker";

/**
 * /check-vendor (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV6-CV9): the free vendor check, rendered in
 * a DOM and typed into, and the page around it: static, public, with its coverage stated, and with nothing that could
 * send what is typed or pasted anywhere, nor a link that carries what a name matched.
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
    const link = container.querySelector('a[href="https://sanctionssearch.ofac.treas.gov/"]');
    expect(link?.textContent).toContain("Check it on Treasury's search");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noreferrer");
    expect(link?.parentElement?.textContent).toContain("by its name, BANK MELLI IRAN.");
    // A link to another site is within reach of analytics' outbound-click events: none carries what the name matched.
    for (const each of container.querySelectorAll("a[href]")) expect(each.getAttribute("href")).not.toMatch(/\d/);
  });

  it("says plainly when a name finds nothing, with the list's date", async () => {
    type(field("Vendor name"), "Northwind Design");
    await click("Check this name");
    expect(live()?.textContent).toContain("No match in OFAC's SDN list as of Oct 28, 2026.");
    expect(text()).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
  });

  it("says a name of rare words of a listed name is a possible match, and why", async () => {
    type(field("Vendor name"), "Suex");
    await click("Check this name");
    expect(live()?.textContent).toContain("Possible match: review it");
    expect(text()).toContain("SUEX OTC, S.R.O.");
    expect(text()).toContain("Matched its name: suex is the same word. Only in that name: otc. Every word typed is rare on the list, so it is a possible match at least.");
  });

  it("does not compare a name with no word in Latin letters, and says so rather than no match", async () => {
    type(field("Vendor name"), "Сбербанк России");
    await click("Check this name");
    expect(live()?.textContent).toContain("Not compared: OFAC's SDN list writes every name in Latin letters");
    expect(live()?.textContent).not.toContain("No match");
    type(field("Vendor name"), "Northwind Design 中国银行");
    await click("Check this name");
    expect(live()?.textContent).toContain("No match in OFAC's SDN list as of Oct 28, 2026.");
    expect(text()).toContain("Left out, as they are not in Latin letters: 中国银行.");
    // A legal form in Latin letters says nothing of who the vendor is: the name is still not compared.
    type(field("Vendor name"), "Сбербанк PJSC");
    await click("Check this name");
    expect(live()?.textContent).toContain("Not compared: OFAC's SDN list writes every name in Latin letters");
    expect(live()?.textContent).not.toContain("No match");
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

  it("reads one pasted column whole, and counts a name not in Latin letters apart", async () => {
    type(container.querySelector("textarea")!, "Vendor\nKadyrov, Ramzan\nСбербанк");
    await click("Read the list");
    expect(text()).toContain("2 rows, 1 column.");
    await click("Check the list");
    expect(live("in the list")?.textContent).toContain("2 rows checked: 0 strong matches, 1 possible match, 0 with no match, 1 not compared (not in Latin letters).");
    expect(text()).toContain("KADYROV, Ramzan Akhmatovich");
    expect(text()).toContain("Not compared: OFAC's SDN list writes every name in Latin letters.");
  });

  it("gives the counts the look-at tone when the only rows to look at were not compared", async () => {
    type(container.querySelector("textarea")!, "Vendor\nСбербанк России\nРоснефть LLC");
    await click("Read the list");
    await click("Check the list");
    const counts = live("in the list")?.firstElementChild;
    expect(counts?.textContent).toContain("2 not compared (not in Latin letters)");
    expect(counts?.className).toContain("bg-held-soft");
  });

  it("reads past a title line above the column names, and says so", async () => {
    type(container.querySelector("textarea")!, "Vendor Contact List\nVendor,Country,Wallet\nBank Melli Iran,IR,");
    await click("Read the list");
    expect(text()).toContain("1 row, 3 columns.");
    expect(text()).toContain("Above its column names, not checked: Vendor Contact List.");
    expect(text()).toContain("Reads: Bank Melli Iran");
    await click("Check the list");
    expect(live("in the list")?.textContent).toContain("1 strong match");
  });

  it("shows a name the list cut at its commas as it checks it, whole, in its columns and the CSV", async () => {
    type(container.querySelector("textarea")!, "Country,Vendor\nRU,Kadyrov, Ramzan");
    await click("Read the list");
    expect(text()).toContain("1 row, 2 columns.");
    expect(text()).toContain("Reads: Kadyrov, Ramzan");
    expect(text()).not.toContain("Column C");
    await click("Check the list");
    let saved: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      saved = blob as Blob;
      return "blob:results";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await click("Download the results (CSV)");
    const [header, row] = (await saved!.text()).slice(1).split("\r\n");
    expect(header).toBe("Country,Vendor,OFAC SDN result,Possible matches,Wallet result,SDN list as of");
    expect(row.startsWith('RU,"Kadyrov, Ramzan",')).toBe(true);
  });

  it("wraps a long address in the folded rows, so it stays inside the page on a phone", async () => {
    type(container.querySelector("textarea")!, `Vendor,Wallet\nNorthwind Design,eth:0x${"12".repeat(20)}`);
    await click("Read the list");
    await click("Check the list");
    const folded = [...container.querySelectorAll("details li")];
    expect(folded).toHaveLength(1);
    expect(folded[0].textContent).toContain(`Read as 0x${"12".repeat(20)}.`);
    expect(folded[0].className).toContain("break-words");
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
    // The line every free tool's page says under its introduction (free tool attribution TA6).
    expect(markup).toContain(
      "The check runs in this page, and nothing you type or paste is kept. This page may count the visit and a click on Try it on your bills, by its address. What you paste or type is never sent. OFAC&#x27;s SDN list as of"
    );
    expect(page).toContain("{FREE_TOOL_COUNT_LINE}");
    expect(markup).toContain("What this check covers, and what it does not");
    expect(markup).toContain("OFAC&#x27;s SDN list only");
    expect(markup).toContain("not a compliance decision");
    expect(markup).toContain('href="https://sanctionssearch.ofac.treas.gov/"');
    const { requiresSession } = await import("@/lib/auth/routes");
    expect(requiresSession("/check-vendor")).toBe(false);
  });

  it("warns before each link opens a new tab, and reads the list's date without the names snapshot", async () => {
    const { default: CheckVendorPage } = await import("@/app/check-vendor/page");
    const markup = renderToStaticMarkup(<CheckVendorPage />);
    // The page's own links, to Treasury's search and to the script that refreshes the list.
    const newTab = (markup.match(/<a [^>]*target="_blank"[^>]*>[\s\S]*?<\/a>/g) ?? []).filter((link) => /sanctionssearch|ofac-sdn-wallets\.mjs/.test(link));
    expect(newTab).toHaveLength(2);
    for (const link of newTab) expect(link).toContain("(opens in a new tab)");
    // The server page would otherwise carry the whole 2 MB snapshot for one date; the wallet snapshot has the same one.
    expect(source("src/app/check-vendor/page.tsx")).not.toContain("ofac-sdn-names.json");
    expect(markup).toContain("OFAC&#x27;s SDN list as of Oct 28, 2026.");
  });

  it("says each wallet is looked up among OFAC's addresses, and only 0x wallets are compared with each other", async () => {
    const { default: CheckVendorPage } = await import("@/app/check-vendor/page");
    const markup = renderToStaticMarkup(<CheckVendorPage />).replace(/\s+/g, " ");
    expect(markup).toContain("and each wallet address with the addresses that list gives.");
    expect(markup).toContain(
      "A 0x wallet is also compared with the other 0x wallets in your list, so one made to look like another vendor&#x27;s, or one two vendors share, shows up."
    );
    expect(markup).toContain(
      "Only the 0x wallets in your list are compared with each other. A wallet in another format, such as a Bitcoin or Tron address, is only looked up among the addresses OFAC&#x27;s list gives: one two vendors share, or one made to look like another, is not pointed out."
    );
    // `vendorRowChecker` compares no other wallet with the other rows, so the page never says every one is.
    expect(markup).not.toContain("the rest of your list");
  });

  it("says how close spellings count, as the matcher counts them", async () => {
    const { default: CheckVendorPage } = await import("@/app/check-vendor/page");
    const markup = renderToStaticMarkup(<CheckVendorPage />).replace(/\s+/g, " ");
    expect(markup).toContain("A word spelled another way, such as Hezbollah for Hizballah, counts for nine tenths of the same word.");
    expect(markup).toContain("A word only close to one, such as Kadhafi for Qadhafi, counts for between half and nine tenths of it");
    expect(markup).not.toContain("a little less");
  });

  it("ends with the call to action, the free tools' shared start button, and names the tool to its footer", async () => {
    const { default: CheckVendorPage } = await import("@/app/check-vendor/page");
    const markup = renderToStaticMarkup(<CheckVendorPage />);
    expect(markup).toContain("In shadow mode it decides on your real bills while you keep paying them as you do now.");
    // The shared start button (free tool attribution TA3), named check-vendor-start for the analytics click.
    expect(source("src/components/vendor-check/VendorCheckCta.tsx")).toContain('<ToolCta tool="check-vendor" />');
    const start = markup.match(/<a [^>]*data-cta="check-vendor-start"[^>]*>[^<]*<\/a>/)?.[0] ?? "";
    expect(start).toContain(`href="${TRY_HREF}"`);
    expect(start).toContain(`>${TRY_LABEL}</a>`);
    // The full footer's Get started, the page's other start, credits the tool too (TA5).
    expect(source("src/app/check-vendor/page.tsx")).toContain('<SiteFooter tool="check-vendor" />');
    expect(markup).toMatch(/<a [^>]*href="\/onboarding\?shadow=1"[^>]*>Get started<\/a>/);
    // What the product does, as its code does it: this page's score is not the product's screening score.
    expect(markup).toContain("The agent pays no vendor until screening gives a verdict, and no one can pay a vendor screened high risk.");
    expect(markup).not.toContain("never pays a vendor with a strong match");
    expect(markup).not.toContain("the score from which");
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
