import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { actionEmailHtml } from "@/lib/email/layout";
import { firstTouchFrom } from "@/lib/growth/attribution";
import { LOOP_CAMPAIGN, LOOP_EMAILS, LOOP_PAGES, loopCtaId, loopEmailUrl, loopPageHref } from "@/lib/growth/loop";
import { growthMetrics, type WorkspaceRow } from "@/lib/growth/metrics";

/**
 * The counterparty loop (docs/superpowers/specs/2026-10-19-counterparty-loop-design.md C1-C4): every public page and
 * email a business sends its suppliers, payees and customers links back to Vestiarion, tagged with the kind of page
 * only; the landing page's first touch keeps the tags; /admin/growth counts the workspaces opened from them. Member
 * emails and workspace pages carry no such link.
 */

vi.mock("server-only", () => ({}));
const { SiteFooter } = await import("@/components/vx/SiteChrome");
const { CTA_ID } = await import("@/components/analytics/GoogleAnalytics");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the loop's links", () => {
  it("tag the landing page with the kind of page or email, the medium and the campaign, and nothing else", () => {
    expect(loopPageHref("supplier_status")).toBe("/?utm_source=supplier_status&utm_medium=counterparty_page&utm_campaign=counterparty_loop");
    expect(loopEmailUrl("https://www.vestiarion.xyz/", "payment_notice")).toBe(
      "https://www.vestiarion.xyz/?utm_source=payment_notice&utm_medium=counterparty_email&utm_campaign=counterparty_loop"
    );
  });

  it("are kept as the landing page's first touch, as any campaign's", () => {
    const href = loopPageHref("payee_link");
    const touch = firstTouchFrom({ search: href.slice(1), pathname: "/", host: "www.vestiarion.xyz" }, "https://www.vestiarion.xyz/payee/vxp_x", new Date("2026-10-19T00:00:00Z"));
    expect(touch).toMatchObject({ utm_source: "payee_link", utm_medium: "counterparty_page", utm_campaign: LOOP_CAMPAIGN, landing_path: "/" });
    // Arriving from our own page, no referring site is kept: nothing of the page the person came from.
    expect(touch?.referrer_host).toBeUndefined();
  });
});

describe("a counterparty page's footer", () => {
  it("says what sent it and links to the landing page in a new tab, tagged", () => {
    const html = renderToStaticMarkup(<SiteFooter compact loop="receipt" />);
    expect(text(html)).toContain("Sent with Vestiarion, the AI agent for bills and payments. Try it on your own bills");
    const link = html.match(/<a[^>]*data-cta="loop-receipt"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="/?utm_source=receipt&amp;utm_medium=counterparty_page&amp;utm_campaign=counterparty_loop"');
    expect(link).toContain('target="_blank"');
    // The page's address holds its token: the new tab is told nothing of it.
    expect(link).toContain('rel="noopener noreferrer"');
    expect(text(html)).toContain("Try it on your own bills (opens in a new tab)");
  });

  it("names each page's click in words the analytics accept", () => {
    for (const page of LOOP_PAGES) expect(CTA_ID.test(loopCtaId(page)), page).toBe(true);
    expect(renderToStaticMarkup(<SiteFooter compact loop="supplier_status" />)).toContain('data-cta="loop-supplier-status"');
  });

  it("says nothing of it on any other public page", () => {
    expect(text(renderToStaticMarkup(<SiteFooter compact />))).not.toContain("Sent with Vestiarion");
  });

  it.each([
    ["supplier", "supplier_status"],
    ["payee", "payee_link"],
    ["receipt", "receipt"],
    ["offer", "early_offer"],
    ["discount", "customer_discount"],
    ["more-time", "more_time"],
    ["pay", "pay_link"],
    ["statement", "statement"],
    ["report", "shared_report"],
    ["documents", "document_request"],
  ] as const)("is on the %s page, as %s", (route, page) => {
    expect(LOOP_PAGES).toContain(page);
    expect(readFileSync(`src/app/${route}/[token]/page.tsx`, "utf8")).toContain(`<SiteFooter compact loop="${page}"`);
  });
});

describe("an email's footer", () => {
  const base = { title: "t", preheader: "p", eyebrow: "e", heading: "h", paragraphsHtml: ["x"], button: { label: "Open", link: "https://www.vestiarion.xyz/x" }, note: "n", origin: "https://www.vestiarion.xyz" };

  it("names what Vestiarion is now, and links back, tagged, only in a counterparty's email", () => {
    const member = actionEmailHtml(base);
    expect(member).toContain("The AI agent for bills and payments, settled in USDC on Arc.");
    expect(member).not.toContain("autonomous treasury agent");
    expect(member).not.toContain("Run your own bills with it");

    const counterparty = actionEmailHtml({ ...base, loop: "early_offer" });
    expect(text(counterparty)).toContain("Run your own bills with it: vestiarion.xyz");
    expect(counterparty).toContain('href="https://www.vestiarion.xyz/?utm_source=early_offer&amp;utm_medium=counterparty_email&amp;utm_campaign=counterparty_loop"');
  });

  it.each([
    ["payment-notice", "payment_notice"],
    ["payee-link", "payee_link"],
    ["address-request", "address_request"],
    ["early-payment-offer", "early_offer"],
    ["term-request", "term_request"],
    ["customer-discount", "customer_discount"],
    ["receivable-reminder", "receivable_reminder"],
    ["document-request", "document_request"],
  ] as const)("links back from every %s email, as %s", (file, email) => {
    expect(LOOP_EMAILS).toContain(email);
    const source = readFileSync(`src/lib/email/${file}.ts`, "utf8");
    expect(source.split("actionEmailHtml({").length - 1).toBe(source.split(`loop: "${email}"`).length - 1);
  });

  it.each(["decision-escalation", "payee-address", "payee-invoice", "payment-stuck", "collection-task", "customer-wrote", "activation-nudge", "document-received"])("never from a member's %s email", (file) => {
    expect(readFileSync(`src/lib/email/${file}.ts`, "utf8")).not.toContain("loop:");
  });
});

describe("/admin/growth's count", () => {
  const workspace = (extra: Partial<WorkspaceRow>): WorkspaceRow => ({
    orgId: crypto.randomUUID(),
    slug: "w",
    network: "arc-testnet",
    side: "customers",
    createdAt: "2026-10-19T10:00:00Z",
    mode: "live",
    shadow: false,
    attribution: null,
    lead: null,
    firstRealBillAt: null,
    realBills: 0,
    realBillsWithin7dOfFirst: 0,
    firstDecisionAt: null,
    verdictsGiven: 0,
    verdictsAgreed: 0,
    livePayments: 0,
    liveUsdc: 0,
    members: 1,
    ...extra,
  });
  const fromLoop = { utmSource: "supplier_status", utmMedium: "counterparty_page", utmCampaign: LOOP_CAMPAIGN, ref: null, referrerHost: null, landingPath: "/" };

  it("counts the customer workspaces first reached from the loop, and those with a decision on a real bill", () => {
    const metrics = growthMetrics({
      leads: [],
      events: [],
      workspaces: [
        workspace({ attribution: fromLoop, firstDecisionAt: "2026-10-19T10:05:00Z" }),
        workspace({ attribution: { ...fromLoop, utmSource: "payment_notice" } }),
        workspace({ attribution: { ...fromLoop, utmCampaign: "agency-oct" } }),
        // Our own team's workspace never counts.
        workspace({ attribution: fromLoop, side: "ours" }),
      ],
      spend: [],
      revenue: [],
      now: new Date("2026-10-19T12:00:00Z"),
    });
    expect(metrics.fromLoop).toEqual({ workspaces: 2, activated: 1 });
  });
});
