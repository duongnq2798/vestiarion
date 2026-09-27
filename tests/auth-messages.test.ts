import { describe, expect, it } from "vitest";
import {
  SIGN_IN_FAILED,
  SIGN_IN_RATE_LIMITED,
  loginErrorMessage,
  signInFailureMessage,
} from "@/lib/auth/messages";

describe("signInFailureMessage — why a sign-in link was not sent", () => {
  // Observed on production 2026-09-27: Supabase refused with "email rate limit
  // exceeded" (an hourly, project-wide cap) and the page told the person to
  // "try again in a minute" — which fails again for up to an hour.
  it.each([
    [{ status: 429, code: "over_email_send_rate_limit" }],
    [{ code: "over_email_send_rate_limit" }],
    [{ code: "over_request_rate_limit" }],
    [{ status: 429 }],
  ])("says the limit was reached when Supabase rate-limits: %j", (error) => {
    expect(signInFailureMessage(error)).toBe(SIGN_IN_RATE_LIMITED);
  });

  it("never promises a retry window it cannot know", () => {
    expect(SIGN_IN_RATE_LIMITED).not.toMatch(/minute/i);
    expect(SIGN_IN_FAILED).not.toMatch(/minute/i);
  });

  it.each([
    [{ status: 500, code: "unexpected_failure" }],
    [{ status: 400 }],
    [null],
    [undefined],
  ])("falls back to the general message otherwise: %j", (error) => {
    expect(signInFailureMessage(error)).toBe(SIGN_IN_FAILED);
  });

  it("never echoes the provider's own message into the page", () => {
    const error = { status: 500, code: "unexpected_failure", message: "<b>smtp relay 10.0.0.4 refused</b>" };
    expect(signInFailureMessage(error)).not.toContain("smtp");
  });
});

describe("loginErrorMessage", () => {
  it("explains a link that failed to exchange, which is usually a different browser", () => {
    expect(loginErrorMessage("link")).toMatch(/same browser/);
  });

  it("explains a Google sign-in that did not start", () => {
    expect(loginErrorMessage("google")).toMatch(/Google/);
  });

  it("says nothing for no code or an unknown one, rather than echoing input", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("<script>")).toBeNull();
  });
});
