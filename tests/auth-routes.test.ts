import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, loginRedirectFor, requiresSession, safeNext } from "@/lib/auth/routes";

describe("safeNext — where to go after signing in", () => {
  it.each([
    ["/o/founding/console", "/o/founding/console"],
    ["/o/founding/audit?domain=treasury", "/o/founding/audit?domain=treasury"],
    ["/o/founding/audit#seq-12", "/o/founding/audit#seq-12"],
    ["/onboarding", "/onboarding"],
  ])("keeps a same-site path: %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["//evil.example"],
    ["/\\evil.example"],
    ["https://evil.example/o/founding"],
    ["javascript:alert(1)"],
    ["o/founding/console"],
    ["/o/founding\n/console"],
    ["/.//evil.example"],
    ["/..//evil.example"],
    ["/%2e//evil.example"],
    ["/o/../..//evil.example"],
  ])("sends anything else to the default: %s", (input) => {
    expect(safeNext(input as string | null | undefined)).toBe(DEFAULT_AFTER_LOGIN);
  });
});

describe("requiresSession", () => {
  it.each([
    ["/o/founding/console", true],
    ["/o/founding", true],
    ["/onboarding", true],
    ["/invite/x", true],
    ["/", false],
    ["/login", false],
    ["/auth/callback", false],
    ["/api/ledger/verify", false],
  ])("%s → %s", (pathname, expected) => {
    expect(requiresSession(pathname)).toBe(expected);
  });
});

describe("loginRedirectFor", () => {
  it("sends a signed-out visitor of a product page to login, remembering the page", () => {
    expect(loginRedirectFor("/o/founding/audit", "?domain=treasury", false)).toBe(
      "/login?next=%2Fo%2Ffounding%2Faudit%3Fdomain%3Dtreasury"
    );
  });

  it("lets a signed-in visitor through", () => {
    expect(loginRedirectFor("/o/founding/audit", "", true)).toBeNull();
  });

  it("sends a signed-out visitor of an invitation link to login, remembering the token", () => {
    expect(loginRedirectFor("/invite/x", "", false)).toBe("/login?next=%2Finvite%2Fx");
  });

  it("never redirects a public page", () => {
    expect(loginRedirectFor("/", "", false)).toBeNull();
    expect(loginRedirectFor("/login", "?next=%2Fo", false)).toBeNull();
  });
});
