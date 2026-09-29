import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import VerifyLedgerBadge, { verificationVerdict } from "@/components/VerifyLedgerBadge";

describe("verificationVerdict", () => {
  it("has nothing to say before a check", () => {
    expect(verificationVerdict(null)).toBeNull();
  });

  it("says an intact chain in the proof tone, with its counts", () => {
    expect(verificationVerdict({ valid: true, checkedEntries: 12 })).toEqual({
      tone: "proof",
      title: "Chain intact",
      body: "12 signatures and 11 links verified.",
    });
  });

  it("names where a broken chain breaks", () => {
    expect(verificationVerdict({ valid: false, brokenAt: 42, reason: "hash mismatch" })).toEqual({
      tone: "refused",
      title: "Chain broken at #0042",
      body: "hash mismatch",
    });
  });

  it("says a check that reached no verdict is not a finding about the chain", () => {
    const verdict = verificationVerdict({ valid: null, reason: "Failed to fetch" });
    expect(verdict?.tone).toBe("neutral");
    expect(verdict?.title).toBe("Not checked");
    expect(verdict?.body).toBe("Failed to fetch. This is not a finding about the chain.");
  });

  it("reads the API route's `error` field when there is no `reason`, without doubling the full stop", () => {
    const verdict = verificationVerdict({ error: "Sign in to verify this ledger." });
    expect(verdict?.tone).toBe("neutral");
    expect(verdict?.title).toBe("Not checked");
    expect(verdict?.body).toBe("Sign in to verify this ledger. This is not a finding about the chain.");
  });
});

describe("VerifyLedgerBadge", () => {
  it("starts with the button and says nothing has been checked yet", () => {
    const markup = renderToStaticMarkup(<VerifyLedgerBadge orgSlug="acme" />);
    expect(markup).toContain("Verify hash chain");
    expect(markup).toContain("Not yet verified in this session.");
    expect(markup).toContain('type="button"');
  });
});
