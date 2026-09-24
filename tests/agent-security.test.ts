import { describe, expect, it } from "vitest";
import {
  agentSessionProof,
  bearerToken,
  evaluateResetGuard,
  hasValidAgentBearer,
  RESET_CONFIRMATION,
  secureTokenMatches,
} from "@/lib/agent-security";

describe("agent bearer authentication", () => {
  it("accepts an exact bearer token", () => {
    expect(hasValidAgentBearer("Bearer correct-horse-battery-staple", "correct-horse-battery-staple")).toBe(true);
  });

  it.each([null, "", "Basic token", "Bearer", "Bearer wrong", "bearer correct-horse-battery-staple"])(
    "rejects absent or malformed authorization: %s",
    (authorization) => {
      expect(hasValidAgentBearer(authorization, "correct-horse-battery-staple")).toBe(false);
    }
  );

  it("fails closed when the server token is not configured", () => {
    expect(hasValidAgentBearer("Bearer anything", undefined)).toBe(false);
  });

  it("parses only a single canonical bearer credential", () => {
    expect(bearerToken("Bearer abc.def-123")).toBe("abc.def-123");
    expect(bearerToken("Bearer abc def")).toBeNull();
  });

  it("compares session proofs without exposing the bearer token", () => {
    const proof = agentSessionProof("top-secret");
    expect(proof).not.toContain("top-secret");
    expect(secureTokenMatches(proof, agentSessionProof("top-secret"))).toBe(true);
    expect(secureTokenMatches(proof, agentSessionProof("other-secret"))).toBe(false);
  });
});

describe("reset guard", () => {
  it("does not distinguish missing and wrong credentials", () => {
    expect(evaluateResetGuard({ authorized: false, confirmation: undefined, isProduction: false, allowDestructiveReset: false }))
      .toEqual({ allowed: false, status: 401, error: "Unauthorized" });
  });

  it("requires the exact explicit confirmation", () => {
    expect(evaluateResetGuard({ authorized: true, confirmation: "yes", isProduction: false, allowDestructiveReset: false }))
      .toEqual({ allowed: false, status: 400, error: "Confirmation required" });
  });

  it("blocks production resets unless explicitly enabled", () => {
    expect(evaluateResetGuard({ authorized: true, confirmation: RESET_CONFIRMATION, isProduction: true, allowDestructiveReset: false }))
      .toEqual({ allowed: false, status: 403, error: "Reset disabled" });
  });

  it("allows confirmed development resets and explicitly enabled production resets", () => {
    expect(evaluateResetGuard({ authorized: true, confirmation: RESET_CONFIRMATION, isProduction: false, allowDestructiveReset: false }))
      .toEqual({ allowed: true });
    expect(evaluateResetGuard({ authorized: true, confirmation: RESET_CONFIRMATION, isProduction: true, allowDestructiveReset: true }))
      .toEqual({ allowed: true });
  });
});
