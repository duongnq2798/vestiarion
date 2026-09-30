import { describe, expect, it } from "vitest";
import { redactPath, redactReferrer, redactTitle } from "@/lib/analytics/redact";

const ORIGIN = "https://vestiarion.xyz";

describe("redactPath", () => {
  it.each([
    ["/invite/abc", "/invite/:token"],
    ["/invite/abc/", "/invite/:token"],
    ["/invite/abc/extra", "/invite/:token"],
    ["/payee/vxp_secret", "/payee/:token"],
    ["/payee/vxp_secret/", "/payee/:token"],
    ["/o/acme", "/o/:org"],
    ["/o/acme/", "/o/:org/"],
    ["/o/acme/audit", "/o/:org/audit"],
    ["/", "/"],
    ["/docs/api", "/docs/api"],
  ])("redacts %s as %s", (pathname, expected) => {
    expect(redactPath(pathname)).toBe(expected);
  });
});

describe("redactReferrer", () => {
  it.each([
    ["", ""],
    ["not a url", ""],
    [`${ORIGIN}/invite/abc?next=x#y`, `${ORIGIN}/invite/:token`],
    [`${ORIGIN}/o/acme/settings`, `${ORIGIN}/o/:org/settings`],
    [`${ORIGIN}/login?next=%2Fo%2Facme`, `${ORIGIN}/login`],
    [`${ORIGIN}/docs/api`, `${ORIGIN}/docs/api`],
    ["https://mail.example.com/inbox/123?q=invite", "https://mail.example.com/"],
  ])("redacts %s as %s", (referrer, expected) => {
    expect(redactReferrer(referrer, ORIGIN)).toBe(expected);
  });
});

describe("redactTitle", () => {
  it("keeps the title of a page whose path is public", () => {
    expect(redactTitle("/docs/api", "API reference · Vestiarion")).toBe("API reference · Vestiarion");
  });

  it("replaces a workspace title, which names the organization, with the redacted path", () => {
    expect(redactTitle("/o/acme/audit", "Audit log · Acme · Vestiarion")).toBe("/o/:org/audit");
    expect(redactTitle("/o/acme", "Acme · Vestiarion")).toBe("/o/:org");
  });

  it("replaces an invite title with the redacted path", () => {
    expect(redactTitle("/invite/abc", "Accept invitation · Vestiarion")).toBe("/invite/:token");
  });
});
