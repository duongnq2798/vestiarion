import { describe, expect, it } from "vitest";
import { afterSignInTarget } from "@/lib/auth/after-sign-in";

/**
 * `afterSignInTarget`: the pure decision behind the `vx_after_sign_in`
 * cookie — an explicit `next` wins, the cookie is the fallback, and both go
 * through `safeNext` so neither can produce an open redirect.
 */

describe("afterSignInTarget", () => {
  it("uses the explicit next when one is given, even with a cookie present", () => {
    expect(afterSignInTarget("/o/founding/console", "/invite/abc123")).toBe("/o/founding/console");
  });

  it("falls back to the cookie when there is no explicit next", () => {
    expect(afterSignInTarget(null, "/invite/abc123")).toBe("/invite/abc123");
    expect(afterSignInTarget(undefined, "/invite/abc123")).toBe("/invite/abc123");
    expect(afterSignInTarget("", "/invite/abc123")).toBe("/invite/abc123");
  });

  it("sends an open redirect in the explicit next to the default", () => {
    expect(afterSignInTarget("//evil.example", "/invite/abc123")).toBe("/onboarding");
    expect(afterSignInTarget("https://evil.example", "/invite/abc123")).toBe("/onboarding");
  });

  it("sends an open redirect in the cookie to the default", () => {
    expect(afterSignInTarget(null, "//evil.example")).toBe("/onboarding");
    expect(afterSignInTarget(null, "https://evil.example")).toBe("/onboarding");
  });

  it("defaults to onboarding when neither is given", () => {
    expect(afterSignInTarget(undefined, undefined)).toBe("/onboarding");
    expect(afterSignInTarget(null, null)).toBe("/onboarding");
  });
});
