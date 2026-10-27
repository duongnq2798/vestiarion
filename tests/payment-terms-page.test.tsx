// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentTermsCalculator } from "@/components/payment-terms/PaymentTermsCalculator";

/**
 * /payment-terms and its term pages (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT6 to PT9): the
 * calculator rendered in a DOM and typed into, and the pages around it: static, public, and with nothing that could send
 * what is typed anywhere.
 */

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => "/payment-terms",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

let container: HTMLDivElement;
let root: Root;

function mount(terms?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PaymentTermsCalculator initialTerms={terms} />));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.useRealTimers();
});

/** Every piece of text, a space between each, so a term and its value read as "Due date Nov 27, 2026". */
function text(): string {
  const walker = document.createTreeWalker(container, 4 /* text nodes */);
  const pieces: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) pieces.push(node.textContent ?? "");
  return pieces.join(" ").replace(/\s+/g, " ");
}
const live = () => container.querySelector('[aria-live="polite"]')?.textContent?.replace(/\s+/g, " ") ?? "";

/** The links in a page's markup to a section of the same page, `href="#…"`, whose section is not on it. */
function missingSections(markup: string): string[] {
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  return [...markup.matchAll(/\bhref="#([^"]*)"/g)].map((match) => match[1]).filter((id) => !ids.has(id));
}

/** The control a label names, by its `for`. */
function control(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find((each) => each.textContent?.replace(/\(optional\)/, "").trim() === label);
  if (!found) throw new Error(`no label ${label}`);
  const element = container.querySelector(`[id="${found.htmlFor}"]`);
  if (!element) throw new Error(`no control for ${label}`);
  return element as HTMLInputElement;
}

function type(label: string, value: string) {
  const input = control(label);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button ${label}`);
  act(() => button.click());
}

describe("the calculator (PT6)", () => {
  it("starts from today, 1,000 USD and 2/10 net 30, and has no form that could submit it", () => {
    mount();
    expect(container.querySelector("form")).toBeNull();
    expect(control("Invoice date").value).toBe("2026-10-28");
    expect(control("Amount").value).toBe("1000");
    expect(control("Terms").value).toBe("2/10 net 30");
    expect(live()).toContain("Pay on Nov 7, 2026");
    expect(live()).toContain("A 2% early-payment discount (20.00 USD) is worth more than holding the cash to the due date (0.00 USD of yield)");
    expect(text()).toContain("Due date Nov 27, 2026");
    expect(text()).toContain("Discount deadline Nov 7, 2026");
    expect(text()).toContain("980.00 USD instead of 1,000.00 USD: it saves 20.00 USD.");
    expect(text()).toContain("2 ÷ 98 × 365 ÷ 20 = 37.2%");
    expect(text()).toContain("2 ÷ 98 × 360 ÷ 20 = 36.7%");
    expect(text()).toContain("(1 + 2 ÷ 98) ^ (365 ÷ 20) − 1 = 44.6%");
    expect(text()).toContain("Break-even rate 37.2% a year");
    // Only the decision is announced as it changes, not the figures under it.
    expect(live()).not.toContain("37.2%");
  });

  it("moves the day to the due date once the cash earns more than the break-even rate", () => {
    mount();
    type("Yearly rate your cash earns, or your borrowing costs", "40");
    expect(live()).toContain("Pay on Nov 27, 2026");
    expect(live()).toContain("Yield to the due date (21.48 USD) is worth more than the 2% early-payment discount (20.00 USD); paying on the due date, Nov 27, 2026.");
  });

  it("fills in a preset, and starts from the term a term page gives it", () => {
    mount();
    click("net 30 EOM");
    expect(control("Terms").value).toBe("net 30 EOM");
    expect(live()).toContain("Pay on Nov 30, 2026");
    expect(live()).toContain("No early-payment discount; paying on the due date, Nov 30, 2026, keeps 1,000.00 USD available until then.");
    expect(text()).not.toContain("Break-even rate");
    act(() => root.unmount());
    container.remove();
    mount("2/10 net 60");
    expect(control("Terms").value).toBe("2/10 net 60");
    expect(text()).toContain("Due date Dec 27, 2026");
    expect(text()).toContain("2 ÷ 98 × 365 ÷ 50 = 14.9%");
  });

  it("shows the late fee at 7, 30 and 60 days and the days chosen, and names it in the decision", () => {
    mount("net 30");
    expect(text()).not.toContain("7 days late");
    type("Late fee", "1.5");
    expect(text()).toContain("7 days late 15.00 USD");
    expect(text()).toContain("60 days late 30.00 USD");
    expect(text()).toContain("1,000.00 × 1.5% × 2 months = 30.00");
    expect(live()).toContain("before a 1.5% monthly late fee (15.00 USD) starts Nov 28, 2026.");
    const byTheDay = [...container.querySelectorAll("label")].find((label) => label.textContent === "By the day");
    act(() => (container.querySelector(`[id="${byTheDay!.htmlFor}"]`) as HTMLButtonElement).click());
    expect(text()).toContain("7 days late 3.45 USD");
    type("Days late", "45");
    expect(text()).toContain("45 days late 22.19 USD");
    expect(text()).toContain("1,000.00 × 1.5% × 12 ÷ 365 × 45 days = 22.19");
  });

  it("says what is wrong under the field, and decides nothing until it can", () => {
    mount();
    type("Terms", "2/30 net 30");
    expect(text()).toContain("The discount's days must be fewer than the net days");
    expect(control("Terms").getAttribute("aria-invalid")).toBe("true");
    expect(live()).toBe("");
    type("Terms", "net 30");
    type("Amount", "a lot");
    expect(text()).toContain("Enter the invoice's amount, such as 1,250.00.");
    expect(live()).toBe("");
    // Less than a cent cannot be shown with the page's 2 decimals: an amount out of range says its range.
    type("Amount", "0.009");
    expect(text()).toContain("An amount is at least 0.01 and at most 1,000,000,000,000.");
    expect(text()).not.toContain("Enter the invoice's amount");
    expect(live()).toBe("");
    type("Amount", "1000000000000.01");
    expect(text()).toContain("An amount is at least 0.01 and at most 1,000,000,000,000.");
    type("Amount", "0.01");
    expect(live()).toContain("Pay on Nov 27, 2026");
    type("Amount", "1,000");
    type("Late fee", "12");
    expect(text()).toContain("A late fee as a percent a month is more than 0 and at most 10, with at most 2 decimal places.");
    expect(live()).toBe("");
    // Terms with a late fee in them say where it goes.
    type("Late fee", "");
    type("Terms", "net 30, 1.5% late fee");
    expect(text()).toContain("a late fee and the invoice date have their own fields.");
    expect(live()).toBe("");
  });

  it("refuses a fixed late fee above the invoice's amount, as a bill does, or under 0.01, which would show as 0.00", () => {
    mount("net 30");
    const fixed = [...container.querySelectorAll("label")].find((label) => label.textContent === "A fixed amount");
    act(() => (container.querySelector(`[id="${fixed!.htmlFor}"]`) as HTMLButtonElement).click());
    type("Late fee", "1000.01");
    expect(text()).toContain("A fixed late fee is at least 0.01 and at most the invoice's amount.");
    expect(live()).toBe("");
    type("Late fee", "0.004");
    expect(text()).toContain("A fixed late fee is at least 0.01 and at most the invoice's amount.");
    expect(live()).toBe("");
    type("Late fee", "1000");
    expect(text()).toContain("7 days late 1,000.00 USD");
  });

  it("says 1 day, not 1 days", () => {
    mount("net 30");
    type("Late fee", "1.5");
    type("Days late", "1");
    expect(text()).toContain("1 day late 15.00 USD");
    // Due Oct 27: a day late today.
    type("Invoice date", "2026-09-27");
    expect(text()).toContain("1 day late, today 15.00 USD");
    type("Terms", "net 1");
    expect(text()).toContain("1 day after the invoice date, every calendar day counted.");
    type("Invoice date", "2026-10-28");
    type("Terms", "2/1 net 30");
    expect(text()).toContain("1 day after the invoice date, the last day 2% comes off.");
    type("Terms", "2/29 net 30");
    expect(text()).toContain("for 1 day and paying");
    expect(text()).not.toMatch(/\b1 days\b/);
  });

  it("pays today when the bill is overdue", () => {
    mount("net 30");
    type("Invoice date", "2026-09-01");
    expect(live()).toContain("Pay today, Oct 28, 2026");
    expect(live()).toContain("Overdue since Oct 1, 2026; paying now.");
  });
});

describe("the page (PT7, PT9)", () => {
  it("is static and public, with its title, canonical address, heading and call to action, and not under /tools", async () => {
    expect(source("src/app/payment-terms/page.tsx")).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: PaymentTermsPage } = await import("@/app/payment-terms/page");
    expect(metadata).toMatchObject({ title: "Payment terms calculator: due date, 2/10 net 30 and late fees", alternates: { canonical: "/payment-terms" } });
    const markup = renderToStaticMarkup(<PaymentTermsPage />);
    expect(markup).toContain("<h1");
    expect(markup).toContain("Payment terms calculator</h1>");
    expect(markup).toContain("Nothing you type is sent anywhere or kept.");
    expect(markup).toContain("What it does not do");
    expect(markup).toContain('href="/payment-terms/2-10-net-30"');
    expect(markup).toContain('href="/payment-terms/net-30-eom"');
    expect(markup).toContain(
      "agent checks every bill before it is paid, weighs an early-payment discount against holding the cash to the due date, and pays in USDC within the limits you set."
    );
    // The decision's sentence is the policy's, with the rate applied as the page's break-even rate is.
    expect(markup).toContain("with your rate applied to the discounted amount");
    // The calculator sits under a heading of its own, so its late-fee heading (an h3) skips no level after the h1.
    const h1 = markup.indexOf("Payment terms calculator</h1>");
    const calculatorHeading = markup.indexOf('<h2 id="calculator" class="sr-only">Work out an invoice</h2>');
    expect(calculatorHeading).toBeGreaterThan(h1);
    expect(markup.indexOf("Invoice date")).toBeGreaterThan(calculatorHeading);
    expect(markup).toContain('id="how-the-calculator-works"');
    // Every link to a section goes to one that is there: the footer's links to the landing's sections go to the landing.
    expect(missingSections(markup)).toEqual([]);
    expect(markup).toContain('href="/#how-it-works"');
    expect(markup).toContain('data-cta="payment-terms-start"');
    expect(markup).toContain('href="/onboarding?shadow=1"');
    expect(markup).toContain("In shadow mode it decides on your real bills while you keep paying them as you do now.");
    expect(markup).not.toMatch(/\bsafe\b|cleared|verified|compliant/i);
    const { requiresSession } = await import("@/lib/auth/routes");
    expect(requiresSession("/payment-terms")).toBe(false);
    expect(requiresSession("/payment-terms/net-30")).toBe(false);
  });
});

describe("the term pages (PT8)", () => {
  it("are generated for the seven terms only", async () => {
    const page = await import("@/app/payment-terms/[term]/page");
    expect(page.generateStaticParams()).toEqual(
      ["2-10-net-30", "1-10-net-30", "2-10-net-60", "3-10-net-30", "net-30", "net-60", "net-30-eom"].map((term) => ({ term }))
    );
    expect(page.dynamicParams).toBe(false);
    expect(await page.generateMetadata({ params: Promise.resolve({ term: "2-10-net-30" }) })).toMatchObject({
      title: "2/10 net 30: meaning, formula and calculator",
      alternates: { canonical: "/payment-terms/2-10-net-30" },
    });
    await expect(page.default({ params: Promise.resolve({ term: "net-31" }) })).rejects.toThrow();
    expect(await page.generateMetadata({ params: Promise.resolve({ term: "net-31" }) })).toEqual({});
  });

  it("each render with their own heading, canonical address and the calculator filled in", async () => {
    const page = await import("@/app/payment-terms/[term]/page");
    const { TERM_PAGES } = await import("@/lib/payment-terms/pages");
    for (const { slug, words } of TERM_PAGES) {
      const params = Promise.resolve({ term: slug });
      expect(await page.generateMetadata({ params }), slug).toMatchObject({ alternates: { canonical: `/payment-terms/${slug}` } });
      const markup = renderToStaticMarkup(await page.default({ params }));
      expect(markup, slug).toContain(`What ${words} means</h1>`);
      expect(markup, slug).toContain(`value="${words}"`);
      expect(markup, slug).not.toContain(`href="/payment-terms/${slug}"`);
      // Two header links, as on the other public pages, so the header fits a 375 px phone; the wordmark goes home.
      expect(markup, slug).not.toMatch(/>Home<\/a>/);
      expect(markup, slug).toMatch(/<a [^>]*href="\/payment-terms"[^>]*>Calculator<\/a>/);
      expect(missingSections(markup), slug).toEqual([]);
    }
  });

  it("explain the term with its formula and a worked example, and fill the calculator in", async () => {
    const { default: TermPage } = await import("@/app/payment-terms/[term]/page");
    const markup = renderToStaticMarkup(await TermPage({ params: Promise.resolve({ term: "2-10-net-30" }) }));
    const plain = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(markup).toContain("What 2/10 net 30 means</h1>");
    expect(plain).toContain("2% off if you pay within 10 days of the invoice date; otherwise the full amount is due 30 days after the invoice date.");
    expect(plain).toContain("An invoice for 1,000.00 USD dated Nov 2, 2026");
    expect(plain).toContain("980.00 USD by Nov 12, 2026");
    expect(plain).toContain("1,000.00 USD by Dec 2, 2026");
    expect(plain).toContain("2 ÷ 98 × 365 ÷ 20 = 37.2%");
    expect(markup).toContain('value="2/10 net 30"');
    expect(markup).toContain('data-cta="payment-terms-start"');
    expect(markup).toContain('href="/payment-terms"');

    const net = renderToStaticMarkup(await TermPage({ params: Promise.resolve({ term: "net-30-eom" }) })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(net).toContain("What net 30 EOM means");
    expect(net).toContain("Dec 30, 2026");
    expect(net).toContain("10 days late costs 15.00 USD, and 45 days late 30.00 USD");
  });
});

describe("nothing sent (PT6)", () => {
  it("the calculator, its rules and its pages make no request, read no address bar and keep nothing", () => {
    for (const file of [
      "src/components/payment-terms/PaymentTermsCalculator.tsx",
      "src/components/payment-terms/TermLinks.tsx",
      "src/lib/payment-terms/read.ts",
      "src/lib/payment-terms/terms.ts",
      "src/lib/payment-terms/cost.ts",
      "src/lib/payment-terms/late-fee.ts",
      "src/lib/payment-terms/decision.ts",
      "src/lib/payment-terms/pages.ts",
      "src/lib/agent/payment-timing.ts",
      "src/lib/agent/late-fee.ts",
      "src/app/payment-terms/page.tsx",
      "src/app/payment-terms/[term]/page.tsx",
    ]) {
      const code = source(file);
      expect(code, file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=/
      );
    }
  });
});
