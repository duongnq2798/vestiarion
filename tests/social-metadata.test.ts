import { describe, expect, it } from "vitest";
import { metadata as landingMetadata } from "@/app/page";
import { PRODUCTION_ORIGIN, resolvePublicOrigin } from "@/lib/public-origin";

describe("public social metadata", () => {
  it("uses the large X card on the landing page", () => {
    expect(landingMetadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("falls back to the canonical production origin", () => {
    expect(resolvePublicOrigin(undefined)).toBe(PRODUCTION_ORIGIN);
    expect(resolvePublicOrigin("   ")).toBe(PRODUCTION_ORIGIN);
  });

  it("normalizes an explicitly configured public origin", () => {
    expect(resolvePublicOrigin(" https://preview.vestiarion.xyz/path ")).toBe(
      "https://preview.vestiarion.xyz",
    );
  });
});
