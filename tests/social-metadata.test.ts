import { describe, expect, it } from "vitest";
import { metadata as landingMetadata } from "@/app/page";
import { PRODUCTION_ORIGIN, resolvePublicOrigin } from "@/lib/public-origin";

describe("public social metadata", () => {
  it("uses the large X card on the landing page", () => {
    expect(landingMetadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("falls back to the canonical production origin", () => {
    expect(resolvePublicOrigin(undefined, undefined)).toBe(PRODUCTION_ORIGIN);
    expect(resolvePublicOrigin("   ", undefined)).toBe(PRODUCTION_ORIGIN);
  });

  it("always names the canonical domain in Vercel production", () => {
    expect(
      resolvePublicOrigin("https://vestiarion.vercel.app", "production"),
    ).toBe(PRODUCTION_ORIGIN);
  });

  it("uses SITE_URL for a Vercel preview", () => {
    expect(resolvePublicOrigin("https://x.vercel.app", "preview")).toBe(
      "https://x.vercel.app",
    );
  });

  it("normalizes an explicitly configured local public origin", () => {
    expect(resolvePublicOrigin(" https://preview.vestiarion.xyz/path ", undefined)).toBe(
      "https://preview.vestiarion.xyz",
    );
  });
});
