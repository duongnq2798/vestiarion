import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSidebarShortcut, SIDEBAR_COOKIE, SIDEBAR_MAX_AGE_SECONDS, sidebarCollapsedFrom, sidebarCollapsedInCookies, sidebarCookie } from "@/components/vx/sidebar-preference";

/**
 * The sidebar's folded or unfolded state (docs/superpowers/specs/2026-10-10-workspace-shell-design.md S3): kept in a
 * first-party cookie the layout reads, so the server draws the right width on the first paint.
 */

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const key = (over: Partial<Parameters<typeof isSidebarShortcut>[0]> = {}) => ({ key: "[", metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, ...over });

describe("the sidebar cookie", () => {
  it("collapses only on the exact word", () => {
    expect(sidebarCollapsedFrom("collapsed")).toBe(true);
    for (const value of ["expanded", "", "COLLAPSED", "collapsed;", undefined, null]) expect(sidebarCollapsedFrom(value)).toBe(false);
  });

  it("is found among the browser's other cookies", () => {
    expect(sidebarCollapsedInCookies("vx_ft=abc; vx_sidebar=collapsed; sb-token=x")).toBe(true);
    expect(sidebarCollapsedInCookies("vx_sidebar=expanded")).toBe(false);
    expect(sidebarCollapsedInCookies("other_vx_sidebar=collapsed")).toBe(false);
    expect(sidebarCollapsedInCookies("")).toBe(false);
  });

  it("is written first-party for a year, for the whole site, and secure over https", () => {
    expect(SIDEBAR_COOKIE).toBe("vx_sidebar");
    expect(SIDEBAR_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(sidebarCookie(true, true)).toBe("vx_sidebar=collapsed; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
    expect(sidebarCookie(false, false)).toBe("vx_sidebar=expanded; Max-Age=31536000; Path=/; SameSite=Lax");
    expect(sidebarCookie(true, true)).not.toMatch(/Domain=/);
  });

  it("is read by the workspace layout, which draws the first paint with it", () => {
    expect(source("src/app/o/[slug]/layout.tsx")).toContain("sidebarCollapsed={sidebarCollapsedFrom(cookieStore.get(SIDEBAR_COOKIE)?.value)}");
  });

  it("is disclosed on the privacy page", () => {
    expect(source("src/app/privacy/page.tsx")).toContain("<code>vx_sidebar</code>");
  });
});

describe("the [ shortcut", () => {
  it("toggles on a bare [ anywhere but a field someone types in", () => {
    expect(isSidebarShortcut(key(), { tagName: "BODY" })).toBe(true);
    expect(isSidebarShortcut(key(), null)).toBe(true);
    expect(isSidebarShortcut(key(), { tagName: "A" })).toBe(true);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) expect(isSidebarShortcut(key(), { tagName })).toBe(false);
    expect(isSidebarShortcut(key(), { tagName: "DIV", isContentEditable: true })).toBe(false);
  });

  it("leaves modified keys, other keys, composition and handled events alone", () => {
    expect(isSidebarShortcut(key({ ctrlKey: true }), null)).toBe(false);
    expect(isSidebarShortcut(key({ metaKey: true }), null)).toBe(false);
    expect(isSidebarShortcut(key({ altKey: true }), null)).toBe(false);
    expect(isSidebarShortcut(key({ key: "]" }), null)).toBe(false);
    expect(isSidebarShortcut(key({ isComposing: true }), null)).toBe(false);
    expect(isSidebarShortcut(key({ defaultPrevented: true }), null)).toBe(false);
  });
});
