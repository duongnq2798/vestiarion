import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateReportShareToken, reportShareTokenHash } from "@/lib/report-share-token";
import { agreementRate } from "@/lib/verdict-rate";

/**
 * A shared report's link (docs/superpowers/specs/2026-10-10-shared-report-design.md S2): `vxs_` and 43 base64url
 * characters, of which only the SHA-256 of the secret is kept, as a receipt link is; and the agreement rate (S7), which
 * the console's shadow mode panel, the report and the shared page all say with one function.
 */

describe("a shared report's link", () => {
  it("is vxs_ and 43 base64url characters, kept only as the SHA-256 of its secret", () => {
    const { token, secretHash } = generateReportShareToken(() => Buffer.alloc(32, 7));
    expect(token).toMatch(/^vxs_[A-Za-z0-9_-]{43}$/);
    const secret = token.slice(4);
    expect(secretHash).toBe(crypto.createHash("sha256").update(secret, "utf8").digest("hex"));
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reportShareTokenHash(token)).toBe(secretHash);
  });

  it("is different each time", () => {
    expect(generateReportShareToken().token).not.toBe(generateReportShareToken().token);
  });

  it.each([
    "",
    "vxs_",
    "vxs_short",
    `vxr_${"a".repeat(43)}`,
    `vxs_${"a".repeat(42)}`,
    `vxs_${"a".repeat(44)}`,
    `vxs_${"a".repeat(42)}=`,
    ` vxs_${"a".repeat(43)}`,
  ])("hashes nothing malformed: %j", (token) => {
    expect(reportShareTokenHash(token)).toBeNull();
  });
});

describe("agreementRate", () => {
  it("is agreed out of agreed and disagreed, to a whole percent", () => {
    expect(agreementRate({ agreed: 4, disagreed: 0 })).toBe(100);
    expect(agreementRate({ agreed: 2, disagreed: 1 })).toBe(67);
    expect(agreementRate({ agreed: 1, disagreed: 2 })).toBe(33);
    expect(agreementRate({ agreed: 1, disagreed: 7 })).toBe(13);
    expect(agreementRate({ agreed: 0, disagreed: 3 })).toBe(0);
  });

  it("is none before any verdict", () => {
    expect(agreementRate({ agreed: 0, disagreed: 0 })).toBeNull();
  });
});
