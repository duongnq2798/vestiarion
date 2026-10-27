// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CTA_ID } from "@/components/analytics/GoogleAnalytics";
import { START_LABEL, TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { requiresSession } from "@/lib/auth/routes";
import { DEFINITIONS } from "@/lib/growth/definitions";
import { FIRST_TOUCH_COOKIE, FIRST_TOUCH_MAX_AGE_SECONDS, firstTouchCookie, parseFirstTouch, sanitizePath, sanitizeTag } from "@/lib/growth/attribution";
import { LOOP_CAMPAIGN } from "@/lib/growth/loop";
import { bySourceWords, growthMetrics, type WorkspaceRow } from "@/lib/growth/metrics";
import { FREE_TOOL_COUNT_LINE, FREE_TOOL_MEDIUM, FREE_TOOLS, FREE_TOOLS_CAMPAIGN, freeTool, freeToolCtaId, freeToolFirstTouch, toolReferrer } from "@/lib/free-tools";

/**
 * Crediting a workspace to the free tool it came from (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md
 * TA1-TA6): the one list of tools, the first touch a tool's start links keep, the button and the full footer's Get
 * started on a tool's page in a DOM, and the From free tools tile on /admin/growth, worked out from made-up workspaces.
 */

vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...props }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => (
    <a href={href} data-prefetch={prefetch === false ? "off" : undefined} {...props}>
      {children}
    </a>
  ),
}));

const { ToolCta } = await import("@/components/public/ToolCta");
const { SiteFooter } = await import("@/components/vx/SiteChrome");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const NOW = new Date("2026-10-28T09:15:00.000Z");
const CHECK_ADDRESS = freeTool("check-address");

describe("the list of free tools (TA1)", () => {
  it("holds the address checker, with a slug, a path, a title and a one-line description", () => {
    expect(FREE_TOOLS.map(({ slug, path: at, title }) => ({ slug, path: at, title }))).toEqual([{ slug: "check-address", path: "/check-address", title: "Address checker" }]);
    for (const tool of FREE_TOOLS) {
      expect(tool.description, tool.slug).toMatch(/^[A-Z][^\n]{20,160}\.$/);
      expect(tool.description.split(". ")).toHaveLength(1);
    }
  });

  it("gives each tool a top-level public path named by its slug, never under /tools", () => {
    for (const tool of FREE_TOOLS) {
      expect(tool.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(tool.path).toBe(`/${tool.slug}`);
      expect(tool.path.startsWith("/tools")).toBe(false);
      expect(requiresSession(tool.path), tool.path).toBe(false);
      // Already in the first-touch cookie's alphabet, so sanitizing changes nothing.
      expect(sanitizeTag(tool.slug)).toBe(tool.slug);
      expect(sanitizePath(tool.path)).toBe(tool.path);
    }
    expect(new Set(FREE_TOOLS.map((tool) => tool.slug)).size).toBe(FREE_TOOLS.length);
  });

  it("has each tool's page name the tool to its full footer, so the footer's Get started credits it too (TA5)", () => {
    for (const tool of FREE_TOOLS) {
      const page = source(`src/app${tool.path}/page.tsx`);
      // Or the compact footer, which has no start link.
      expect(page, tool.path).toMatch(new RegExp(`<SiteFooter tool="${tool.slug}" />|<SiteFooter compact`));
    }
  });

  it("names each start button <slug>-start, an id analytics accepts", () => {
    expect(freeToolCtaId("check-address")).toBe("check-address-start");
    for (const tool of FREE_TOOLS) expect(CTA_ID.test(freeToolCtaId(tool.slug)), tool.slug).toBe(true);
  });
});

describe("a tool's first touch (TA2)", () => {
  it("is the tool's name, free_tool, free_tools, the tool's page, another site's host and the time, nothing else", () => {
    expect(FREE_TOOL_MEDIUM).toBe("free_tool");
    expect(FREE_TOOLS_CAMPAIGN).toBe("free_tools");
    expect(freeToolFirstTouch(CHECK_ADDRESS, "https://www.google.com/search?q=address+poisoning", "www.vestiarion.xyz", NOW)).toEqual({
      utm_source: "check-address",
      utm_medium: "free_tool",
      utm_campaign: "free_tools",
      landing_path: "/check-address",
      referrer_host: "www.google.com",
      first_seen_at: "2026-10-28T09:15:00.000Z",
    });
  });

  it("leaves out a referrer from this site, none, or one that is not a web address, as FirstTouch does", () => {
    for (const referrer of ["https://www.vestiarion.xyz/", "", "android-app://com.slack"]) {
      expect(freeToolFirstTouch(CHECK_ADDRESS, referrer, "www.vestiarion.xyz", NOW), referrer).not.toHaveProperty("referrer_host");
    }
  });

  it("takes the referrer only when the tool's page was the first page the tab loaded, the one that site linked to", () => {
    const google = "https://www.google.com/search?q=address+poisoning";
    expect(toolReferrer(CHECK_ADDRESS, google, "https://www.vestiarion.xyz/check-address")).toBe(google);
    expect(toolReferrer(CHECK_ADDRESS, google, "https://www.vestiarion.xyz/check-address?utm_source=x#top")).toBe(google);
    // After a move inside the site the browser still gives the first page's referrer, which linked to that page instead.
    for (const first of ["https://www.vestiarion.xyz/", "https://www.vestiarion.xyz/check-address/more", "https://www.vestiarion.xyz/docs/check-address", "", "not an address", undefined]) {
      expect(toolReferrer(CHECK_ADDRESS, google, first), String(first)).toBe("");
    }
  });

  it("is written as the first-touch cookie, and reads back the same on the server", () => {
    const touch = freeToolFirstTouch(CHECK_ADDRESS, "https://x.com/", "www.vestiarion.xyz", NOW);
    const cookie = firstTouchCookie(touch, true);
    expect(cookie).toBe(
      `${FIRST_TOUCH_COOKIE}=v=1&s=check-address&m=free_tool&c=free_tools&p=/check-address&h=x.com&at=2026-10-28T09:15:00.000Z; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; Path=/; SameSite=Lax; Secure`
    );
    expect(parseFirstTouch(cookie.split(";")[0].slice(`${FIRST_TOUCH_COOKIE}=`.length))).toEqual(touch);
  });

  it("takes nothing from the page's fields: only the tool, the referrer, the host and the time", () => {
    expect(freeToolFirstTouch.length).toBe(4);
    const code = source("src/lib/free-tools.ts");
    expect(code).not.toMatch(/document\.|window\.|\.value\b|querySelector|FormData/);
  });
});

describe("the start button, in a DOM (TA3)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let jar: string;
  let writes: string[];
  let refuse: boolean;
  // The address this tab first loaded, as the browser's navigation entry gives it; none when undefined.
  let firstPage: string | undefined;
  // For each click that reached the document: whether it was still free to follow the link.
  let followed: boolean[];
  const stopNavigation = (event: Event) => {
    followed.push(!event.defaultPrevented);
    event.preventDefault();
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    jar = "";
    writes = [];
    refuse = false;
    followed = [];
    firstPage = new URL(CHECK_ADDRESS.path, window.location.origin).href;
    vi.spyOn(performance, "getEntriesByType").mockImplementation((type: string) =>
      type === "navigation" && firstPage !== undefined ? ([{ name: firstPage, entryType: "navigation" }] as PerformanceEntryList) : []
    );
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => jar,
      set: (value: string) => {
        if (refuse) throw new Error("cookies are blocked");
        writes.push(value);
        jar = [jar, value.split(";")[0]].filter(Boolean).join("; ");
      },
    });
    Object.defineProperty(document, "referrer", { configurable: true, get: () => "https://www.google.com/search?q=check+an+address" });
    document.addEventListener("click", stopNavigation);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<ToolCta tool="check-address" />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.removeEventListener("click", stopNavigation);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const link = () => container.querySelector("a") as HTMLAnchorElement;
  const kept = () => parseFirstTouch(writes.at(-1)?.split(";")[0].slice(`${FIRST_TOUCH_COOKIE}=`.length));

  it("is Try it on your bills, to the landing's start, named check-address-start, and writes nothing as it renders", () => {
    expect(link().getAttribute("href")).toBe(TRY_HREF);
    expect(link().getAttribute("data-cta")).toBe("check-address-start");
    expect(link().textContent).toBe(TRY_LABEL);
    // The primary button's look, carried onto the link.
    expect(link().className).toContain("bg-agent");
    expect(writes).toEqual([]);
  });

  it("keeps the tool as the first touch when it is chosen", () => {
    act(() => link().click());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(firstTouchCookie(freeToolFirstTouch(CHECK_ADDRESS, document.referrer, window.location.host, NOW), window.location.protocol === "https:"));
    expect(kept()).toEqual({
      utm_source: "check-address",
      utm_medium: "free_tool",
      utm_campaign: "free_tools",
      landing_path: "/check-address",
      referrer_host: "www.google.com",
      first_seen_at: NOW.toISOString(),
    });
  });

  it("keeps it on a middle click, which opens a new tab, but not on a right click", () => {
    act(() => {
      link().dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    });
    expect(writes).toEqual([]);
    act(() => {
      link().dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(kept()?.utm_source).toBe("check-address");
  });

  it("never replaces a first touch the browser already holds, and writes it once", () => {
    jar = `${FIRST_TOUCH_COOKIE}=v=1&s=x&c=launch`;
    act(() => link().click());
    expect(writes).toEqual([]);
    jar = "";
    act(() => link().click());
    act(() => link().click());
    expect(writes).toHaveLength(1);
  });

  it("keeps no referrer when the visit began on another of the site's pages, whose referrer the browser still gives", () => {
    firstPage = new URL("/", window.location.origin).href;
    act(() => link().click());
    expect(kept()).toEqual({
      utm_source: "check-address",
      utm_medium: "free_tool",
      utm_campaign: "free_tools",
      landing_path: "/check-address",
      first_seen_at: NOW.toISOString(),
    });
  });

  it("keeps no referrer where the browser gives no navigation entry", () => {
    firstPage = undefined;
    act(() => link().click());
    expect(kept()?.utm_source).toBe("check-address");
    expect(kept()).not.toHaveProperty("referrer_host");
  });

  it("writes nothing, raises no error and leaves the link to be followed when the browser refuses cookies", () => {
    refuse = true;
    // React reports an error thrown in a click handler to the window instead of throwing it from click().
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      act(() => link().click());
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
    expect(followed).toEqual([true]);
  });

  it("leaves the link to be followed after keeping the tool", () => {
    act(() => link().click());
    expect(writes).toHaveLength(1);
    expect(followed).toEqual([true]);
  });

  it("keeps it from the full footer's Get started on the tool's page too, and not from the footer on other pages (TA5)", () => {
    const footerStart = () => [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === START_LABEL) as HTMLAnchorElement;
    act(() => root.render(<SiteFooter />));
    act(() => footerStart().click());
    expect(writes).toEqual([]);
    act(() => root.render(<SiteFooter tool="check-address" />));
    expect(footerStart().getAttribute("href")).toBe(TRY_HREF);
    // Its click count stays the footer's: it takes no button's analytics name.
    expect(footerStart().hasAttribute("data-cta")).toBe(false);
    act(() => {
      footerStart().dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    });
    expect(writes).toEqual([]);
    act(() => footerStart().click());
    expect(writes).toHaveLength(1);
    expect(kept()).toMatchObject({ utm_source: "check-address", utm_campaign: "free_tools", landing_path: "/check-address", referrer_host: "www.google.com" });
    expect(followed).toEqual([true, true]);
  });

  it("sends nothing and reads no field: its code makes no request and holds no analytics call", () => {
    const code = source("src/components/public/ToolCta.tsx");
    expect(code).toContain('"use client"');
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|gtag|localStorage|sessionStorage|indexedDB|querySelector|\.value\b|useEffect/);
  });

  it("renders the same on the server, with nothing written", () => {
    const markup = renderToStaticMarkup(<ToolCta tool="check-address" />);
    expect(markup).toContain(`href="${TRY_HREF}"`);
    expect(markup).toContain('data-cta="check-address-start"');
    expect(writes).toEqual([]);
  });
});

describe("From free tools on /admin/growth (TA4)", () => {
  const workspace = (extra: Partial<WorkspaceRow>): WorkspaceRow => ({
    orgId: crypto.randomUUID(),
    slug: "w",
    network: "arc-testnet",
    side: "customers",
    createdAt: "2026-10-28T08:00:00Z",
    mode: "sandbox",
    shadow: true,
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
  const fromTool = (slug: string | null) => ({ utmSource: slug, utmMedium: FREE_TOOL_MEDIUM, utmCampaign: FREE_TOOLS_CAMPAIGN, ref: null, referrerHost: null, landingPath: slug ? `/${slug}` : null });
  const decided = "2026-10-28T08:20:00Z";

  const metrics = growthMetrics({
    leads: [],
    events: [],
    workspaces: [
      workspace({ attribution: fromTool("check-address"), firstDecisionAt: decided }),
      workspace({ attribution: fromTool("check-address") }),
      workspace({ attribution: fromTool("payment-terms"), firstDecisionAt: decided }),
      workspace({ attribution: fromTool(null) }),
      // Another campaign's first touch, even one that landed on a tool, is that campaign's.
      workspace({ attribution: { ...fromTool("x"), utmMedium: "social", utmCampaign: "launch", landingPath: "/check-address" }, firstDecisionAt: decided }),
      workspace({ attribution: { ...fromTool("receipt"), utmCampaign: LOOP_CAMPAIGN } }),
      workspace({ attribution: null, firstDecisionAt: decided }),
      // Our own team's workspace never counts.
      workspace({ attribution: fromTool("check-address"), side: "ours", firstDecisionAt: decided }),
    ],
    spend: [],
    revenue: [],
    now: new Date("2026-10-28T12:00:00Z"),
  });

  it("counts customer workspaces first reached from a tool, and those with the agent's decision on a real bill, per tool", () => {
    expect(metrics.fromFreeTools).toEqual({
      workspaces: 4,
      activated: 2,
      bySource: [
        { source: "check-address", workspaces: 2, activated: 1 },
        { source: "none", workspaces: 1, activated: 0 },
        { source: "payment-terms", workspaces: 1, activated: 1 },
      ],
    });
    // The loop's count is unchanged by it.
    expect(metrics.fromLoop).toEqual({ workspaces: 1, activated: 0 });
  });

  it("uses the dashboard's activation definition: the agent's decision on a real bill", () => {
    const activation = DEFINITIONS.find((definition) => definition.metric === "Real-invoice activation rate");
    expect(activation?.limits).toContain("Activation is the agent's decision on a real bill");
    expect(metrics.activation).toMatchObject({ numerator: 4, denominator: 7 });
  });

  it("says the split in words, or that there is none", () => {
    expect(bySourceWords(metrics.fromFreeTools.bySource)).toBe("check-address 2, 1 with a decision · none 1, 0 with a decision · payment-terms 1, 1 with a decision");
    expect(bySourceWords([])).toBe("");
  });

  it("is defined beside From counterparty pages, with where it comes from and what it cannot know", () => {
    const metricNames = DEFINITIONS.map((definition) => definition.metric);
    expect(metricNames.indexOf("From free tools")).toBe(metricNames.indexOf("From counterparty pages") + 1);
    const definition = DEFINITIONS.find((each) => each.metric === "From free tools")!;
    expect(definition.source).toContain("migration 0099");
    expect(definition.calculation).toContain("utm_campaign free_tools");
    expect(definition.calculation).toContain("utm_source");
    expect(definition.calculation).toContain("/check-address");
    for (const phrase of ["same browser within 90 days", "keeps that link's tags", "hand-made link"]) expect(definition.limits, phrase).toContain(phrase);
  });

  it("is a tile right after From counterparty pages on the page", () => {
    const page = source("src/app/admin/growth/page.tsx");
    const loop = page.indexOf('label="From counterparty pages"');
    const tools = page.indexOf('label="From free tools"');
    expect(loop).toBeGreaterThan(0);
    expect(tools).toBeGreaterThan(loop);
    // The next tile's label after the loop's is this one.
    expect(page.slice(loop + 1).match(/label="([^"]+)"/)?.[1]).toBe("From free tools");
    expect(page).toContain("metrics.fromFreeTools.workspaces");
    expect(page).toContain("bySourceWords(metrics.fromFreeTools.bySource)");
  });
});

describe("the line a tool's page says about counting (TA6)", () => {
  it("stays true without analytics, names the click, and says nothing typed is sent", () => {
    expect(FREE_TOOL_COUNT_LINE).toBe("This page may count the visit and a click on Try it on your bills, by its address. What you paste or type is never sent.");
    // Analytics sends the page's path, redacted, and a click's name: never a field's value.
    const analytics = source("src/components/analytics/GoogleAnalytics.tsx");
    expect(analytics).toContain('"cta_click", { cta_id: id, page_path: redactPath(window.location.pathname) }');
    expect(analytics).not.toMatch(/\.value\b|page_location: window\.location\.href/);
  });
});
