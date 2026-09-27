import { describe, expect, it } from "vitest";
import { FOUNDING_ORG_SLUG, isValidSlug, legacyRedirects, orgHref } from "@/lib/auth/org-paths";

describe("isValidSlug — mirrors the orgs.slug check in 0015", () => {
  it.each([
    ["founding", true],
    ["a-b", true],
    ["abc123", true],
    ["a".repeat(40), true],
    ["Founding", false],
    ["ab", false],
    ["-ab", false],
    ["ab-", false],
    ["a b", false],
    ["a".repeat(41), false],
    ["", false],
  ])("%s → %s", (slug, expected) => {
    expect(isValidSlug(slug)).toBe(expected);
  });
});

describe("orgHref", () => {
  it("prefixes an organization path, keeping query and hash", () => {
    expect(orgHref("founding", "/audit?domain=treasury#seq-12")).toBe("/o/founding/audit?domain=treasury#seq-12");
  });

  it("refuses a slug that could not be real", () => {
    expect(() => orgHref("Founding", "/audit")).toThrow(/slug/);
  });

  it("refuses a relative path", () => {
    expect(() => orgHref("founding", "audit")).toThrow(/start with/);
  });
});

describe("legacyRedirects — old bookmarks keep working", () => {
  it("sends every former product path to the founding organization, temporarily", () => {
    expect(legacyRedirects()).toEqual([
      { source: "/console", destination: "/o/founding/console", permanent: false },
      { source: "/audit", destination: "/o/founding/audit", permanent: false },
      { source: "/compliance", destination: "/o/founding/compliance", permanent: false },
      { source: "/contractors", destination: "/o/founding/contractors", permanent: false },
      { source: "/counterparties", destination: "/o/founding/counterparties", permanent: false },
      { source: "/insights", destination: "/o/founding/insights", permanent: false },
      { source: "/invoices", destination: "/o/founding/invoices", permanent: false },
      { source: "/app", destination: "/o/founding/console", permanent: false },
    ]);
    expect(FOUNDING_ORG_SLUG).toBe("founding");
  });
});
