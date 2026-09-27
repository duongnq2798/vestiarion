import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "@/lib/auth/messages";

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
