// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillListChecker } from "@/components/bill-check/BillListChecker";
import { CheckBillsCta } from "@/components/bill-check/CheckBillsCta";
import { TRY_HREF } from "@/components/landing/cta";

/**
 * /check-bills (docs/superpowers/specs/2026-10-28-check-bills-design.md CB1–CB3, CB9–CB11): the free bill list check,
 * rendered in a DOM and driven through its steps with the sample list and with pasted rows, and the page around it:
 * static, public, and with nothing that could send what is pasted anywhere.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/check-bills", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<BillListChecker />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";
const live = () => container.querySelector('[aria-live="polite"][data-results]')?.textContent?.replace(/\s+/g, " ") ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function click(label: string) {
  act(() => button(label).click());
}

/** Lets the check run: it waits for the page to show it is checking first (CB2). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** A day counted from the person's own today, `YYYY-MM-DD`. */
function fromToday(days: number): string {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function type(control: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the checker (CB2, CB3, CB10)", () => {
  it("starts with the list, a file or pasted rows, and has no form that could submit it", () => {
    expect(text()).toContain("1. Your list");
    expect(text()).toContain("Choose a CSV file, or drop one here");
    expect(text()).toContain("Or paste rows from Excel or Google Sheets");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("textarea")?.getAttribute("autocomplete")).toBe("off");
    expect(button("Read the pasted rows").disabled).toBe(true);
    // 16 px on a phone, so the browser does not zoom into it.
    expect(container.querySelector("textarea")?.className).toContain("text-base sm:text-xs");
  });

  it("reads the sample list, shows its columns, and finds what it holds, with the summary announced", async () => {
    click("Try the sample list");
    expect(text()).toContain("Sample list (made-up vendors): 13 bills, 10 columns.");
    expect(text()).toContain("Sample data: made-up vendors and amounts, dated from today.");
    expect(text()).toContain("Which column is which");
    expect(text()).toContain("Reads: Northwind Hosting · Northwind Hosting · Bluebell Print Co.");
    expect(live()).toBe("");

    click("Check 13 bills");
    // Busy for a frame, so a long list shows it is being checked before the page is held.
    expect(button("Check 13 bills").getAttribute("aria-busy")).toBe("true");
    expect(button("Check 13 bills").disabled).toBe(true);
    expect(live()).toBe("");
    await settle();
    expect(text()).toContain("3. What it found");
    expect(live()).toContain("2 likely duplicates");
    expect(live()).toContain("Checked 12 of 13 bills, from 7 vendors.");
    expect(live()).toContain("1,700.00 USD at stake.");
    expect(text()).toContain("Bluebell Print Co.");
    expect(text()).toContain("Row 5 may repeat row 4");
    expect(text()).toContain("Confidence 0.85");
    expect(text()).toContain("Row 4 has the same invoice number, BP-1042, written bp 1042 here.");
    expect(text()).toContain("Same amount, about a month apart");
    expect(text()).toContain("Northwind Hosting: 240.00 USD, 3 bills");
    expect(text()).toContain("Deadlines in the next 7 days");
    expect(text()).toMatch(/to keep the 2% early-payment discount: 19\.60 USD\./);
    expect(text()).toMatch(/to avoid a 1\.5% monthly late fee: 6\.18 USD a month\./);
    expect(text()).toContain("Not checked.");
    expect(text()).toMatch(/Due date “\d{4}-02-30” is not a real day\./);

    click("Check another list");
    expect(text()).toContain("1. Your list");
    expect(live()).toBe("");
  });

  it("downloads the list back with its flag column, made in the page", async () => {
    const made: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      made.push(blob as Blob);
      return "blob:check";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saved = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    click("Try the sample list");
    click("Check 13 bills");
    await settle();
    click("Download the list with a flag column");
    expect(saved).toHaveBeenCalledTimes(1);
    expect((saved.mock.contexts[0] as HTMLAnchorElement).download).toBe("Sample-list-made-up-vendors-checked.csv");
    const csv = await made[0].text();
    expect(csv.split("\r\n")[0]).toContain("Bill check");
    expect(csv).toContain("Likely duplicate of row 4 (confidence 0.85)");
  });

  it("asks for a column the list lacks, and for the order of its dates, before it checks", async () => {
    type(container.querySelector("textarea")!, "Vendor\tAmount\nNorthwind\t240.00");
    click("Read the pasted rows");
    expect(text()).toContain("Pasted rows: 1 bill, 2 columns.");
    expect(text()).toContain("Choose the column for Due date.");
    expect(button("Check 1 bill").disabled).toBe(true);

    click("Choose another list");
    type(container.querySelector("textarea")!, "Vendor\tAmount\tDue\nNorthwind\t240.00\t03/04/2026");
    click("Read the pasted rows");
    expect(text()).toContain("Dates like 03/04/2026 are written");
    expect(button("Check 1 bill").disabled).toBe(true);
    const dayFirst = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')][0];
    act(() => dayFirst.click());
    expect(button("Check 1 bill").disabled).toBe(false);
    click("Check 1 bill");
    await settle();
    expect(live()).toContain("No likely duplicates");
    expect(text()).toContain("Your list has no early-payment discount or late fee columns, so there are no deadlines to check.");
  });

  it("moves the focus to each new step, where the pressed button was, so a keyboard carries on from there", async () => {
    const focused = () => document.activeElement?.textContent;
    expect(document.activeElement).toBe(document.body);
    click("Try the sample list");
    expect(focused()).toBe("2. Columns");
    click("Check 13 bills");
    await settle();
    expect(focused()).toBe("3. What it found");
    click("Change columns");
    expect(focused()).toBe("2. Columns");
    click("Choose another list");
    expect(focused()).toBe("1. Your list");
    type(container.querySelector("textarea")!, "Vendor\tAmount\tDue date\nNorthwind\t240.00\t2026-11-02");
    click("Read the pasted rows");
    expect(focused()).toBe("2. Columns");
    click("Check 1 bill");
    await settle();
    click("Check another list");
    expect(focused()).toBe("1. Your list");
  });

  it("says on a deadline when its bill may repeat another", async () => {
    const row = `Lakeside Freight\tLF-3310\t${fromToday(9)}\t980.00\tUSD\t2\t${fromToday(2)}`;
    type(container.querySelector("textarea")!, ["Vendor\tInvoice\tDue date\tAmount\tCurrency\tDiscount %\tDiscount deadline", row, row].join("\n"));
    click("Read the pasted rows");
    click("Check 2 bills");
    await settle();
    expect(text()).toContain("Lakeside Freight, row 3");
    expect(text()).toContain("This bill may repeat row 2: check it before you pay.");
  });

  it("says when what was pasted cannot be read", () => {
    type(container.querySelector("textarea")!, 'Vendor,Amount\n"Northwind,240.00');
    click("Read the pasted rows");
    expect(text()).toContain("A quoted field is never closed. Check the list's quotes, then try again.");
  });
});

describe("the page (CB1, CB11)", () => {
  it("is static and public, with its own title, canonical address and heading, and not under /tools", async () => {
    const page = source("src/app/check-bills/page.tsx");
    expect(page).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: CheckBillsPage } = await import("@/app/check-bills/page");
    expect(metadata).toMatchObject({ title: "Duplicate invoice check for your bill list, free", alternates: { canonical: "/check-bills" } });
    expect(String(metadata.description)).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
    const markup = renderToStaticMarkup(<CheckBillsPage />).replaceAll("&#x27;", "'");
    expect(markup).toMatch(/<h1[^>]*>Check your bill list for duplicates and deadlines<\/h1>/);
    expect(markup).toContain("Nothing you paste is sent anywhere or kept.");
    expect(markup).toContain("How it works");
    expect(markup).toContain("What it does not do");
    expect(markup).toContain('href="/check-address"');
    // The agent's duplicate rule is told apart from what this page adds to it.
    expect(markup).toContain("This page also compares their invoice numbers, which the agent's rule does not");
    const { requiresSession } = await import("@/lib/auth/routes");
    expect(requiresSession("/check-bills")).toBe(false);
  });

  it("ends with the call to action: Try it on your bills, where the landing's goes, with the shadow-mode line and the import's limit", () => {
    const markup = renderToStaticMarkup(<CheckBillsCta />).replaceAll("&#x27;", "'");
    expect(markup).toContain(
      "Vestiarion runs its duplicate check, purchase-order match, sanctions screening and a payee lock on every new bill, and weighs early-payment discounts and late fees, before it pays. Start a shadow workspace and drop this same file into its bill import."
    );
    const link = /<a[^>]*data-cta="check-bills-start"[^>]*>([^<]*)<\/a>/.exec(markup);
    expect(link?.[0]).toContain(`href="${TRY_HREF}"`);
    expect(link?.[1]).toBe("Try it on your bills");
    expect(markup).toContain("In shadow mode it decides on your real bills while you keep paying them as you do now.");
    expect(markup).toContain("The import takes up to 200 bills at a time");
    expect("check-bills-start").toMatch(/^[a-z][a-z-]{0,39}$/);
  });

  it("sends nothing anywhere: the checker, its rules and the page make no request, and read or write no address bar, storage or cookie", () => {
    const files = [
      "src/components/bill-check/BillListChecker.tsx",
      "src/components/bill-check/BillCheckResults.tsx",
      // What the checker shares with the bill import is held to the same.
      "src/components/intake/list-steps.tsx",
      "src/lib/bill-check/read.ts",
      "src/lib/bill-check/findings.ts",
      "src/lib/bill-check/csv.ts",
      "src/lib/bill-check/sample.ts",
      "src/app/check-bills/page.tsx",
    ];
    for (const file of files) {
      const code = source(file);
      expect(code, file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|useParams|URLSearchParams|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=/
      );
      expect(code, file).not.toMatch(/\bVND\b|\b(?:safe|cleared|verified|compliant)\b/);
    }
    // The call to action is the one place that may later record where a workspace came from (CB9).
    expect(source("src/app/check-bills/page.tsx")).not.toContain("data-cta");
    expect(source("src/components/bill-check/CheckBillsCta.tsx")).toContain('data-cta="check-bills-start"');
  });
});

