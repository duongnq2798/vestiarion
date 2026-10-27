import { referrerHost, type FirstTouch } from "@/lib/growth/attribution";

/**
 * Vestiarion's free public tools (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA1, TA2): one list
 * that the footer's Free tools group, the sitemap and each tool's start button read, so a new tool is one entry, and the
 * first touch the tool's start links keep, so a workspace opened after a tool is credited to it. Pure, safe in client
 * components.
 */

export interface FreeTool {
  /** Lowercase words and hyphens: the tool's utm_source, and `<slug>-start` names its button for analytics. */
  slug: string;
  /** The slug at the top level, public and never under /tools, which serves downloads. */
  path: string;
  /** Its name in the footer. */
  title: string;
  /** What it does, in one sentence. */
  description: string;
}

export const FREE_TOOLS = [
  {
    slug: "check-address",
    path: "/check-address",
    title: "Address checker",
    description: "Check an address before you pay it: whether it is made to look like one you know, hides a character, fails its checksum or is on OFAC's list.",
  },
  {
    slug: "check-vendor",
    path: "/check-vendor",
    title: "OFAC vendor check",
    description: "Check a vendor's name, or your whole vendor list with its wallet addresses, against OFAC's SDN list.",
  },
] as const satisfies readonly FreeTool[];

export type FreeToolSlug = (typeof FREE_TOOLS)[number]["slug"];

/** The medium and the campaign a tool's first touch carries; /admin/growth counts the campaign under From free tools. */
export const FREE_TOOL_MEDIUM = "free_tool";
export const FREE_TOOLS_CAMPAIGN = "free_tools";

/**
 * What a tool's page says under its introduction (TA6). True whether analytics is set up or not ("may"): a page view
 * and a click on the start button name the page by its path, never by anything on it.
 */
export const FREE_TOOL_COUNT_LINE = "This page may count the visit and a click on Try it on your bills, by its address. What you paste or type is never sent.";

export function freeTool(slug: FreeToolSlug): FreeTool {
  return FREE_TOOLS.find((tool) => tool.slug === slug) as FreeTool;
}

/** The start button's name for the analytics click: `<slug>-start`, which `CTA_ID` accepts. */
export function freeToolCtaId(slug: string): string {
  return `${slug}-start`;
}

/** What `toolReferrer` reads of the browser's navigation entry for this document: the address it loaded, and how. */
export type PageLoad = Pick<PerformanceNavigationTiming, "name" | "type">;

/**
 * The referrer a tool's first touch may take (TA2): the page's referrer when `load`, this document's navigation entry,
 * is a fresh load (`navigate`) of the tool's page, the one that site linked to, else none. A move inside the site
 * through the router loads no new document, so the entry and the referrer stay the first page's, which linked to that
 * page and not to the tool. A reload, or a Back or Forward the browser did not keep, loads the tool's page again with
 * the referrer of the history entry it returns to, which a move through the router shares with the first page: so
 * neither keeps one, even when the tool's page was the one that site linked to.
 */
export function toolReferrer(tool: FreeTool, referrer: string, load: PageLoad | undefined): string {
  try {
    return load?.type === "navigate" && new URL(load.name).pathname === tool.path ? referrer : "";
  } catch {
    return "";
  }
}

/**
 * The first touch a tool's start links keep (TA2): the tool's slug, `free_tool` and `free_tools` as its tags, the
 * tool's path as the landing path, the referring site's host by `FirstTouch`'s own rule, and the time. The tags and the
 * path are constants already in the cookie's alphabet (the tests hold them there), and nothing comes from the page's
 * fields: it takes the tool, the referrer (`toolReferrer`), this site's host and the time only.
 */
export function freeToolFirstTouch(tool: FreeTool, referrer: string, host: string, now: Date): FirstTouch {
  const touch: FirstTouch = { utm_source: tool.slug, utm_medium: FREE_TOOL_MEDIUM, utm_campaign: FREE_TOOLS_CAMPAIGN, landing_path: tool.path };
  const from = referrerHost(referrer, host);
  if (from) touch.referrer_host = from;
  touch.first_seen_at = now.toISOString();
  return touch;
}
