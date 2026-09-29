import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { generateStaticParams as generateDocsImageParams } from "@/app/og/docs/[[...slug]]/route";
import { findPage, flatPages } from "@/lib/docs/nav";
import { docsImagePath, docsSocialMetadata } from "@/lib/docs/social";
import { config as proxyConfig } from "@/proxy";
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

describe("docs social images", () => {
  it("serves an image for every page in the docs nav", () => {
    const served = generateDocsImageParams().map(({ slug }) => docsImagePath(slug.join("/")));
    expect(served.sort()).toEqual(flatPages().map((page) => docsImagePath(page.slug)).sort());
  });

  it("points each docs page at its own image, with the large X card", () => {
    const found = findPage("webhooks/verify")!;
    const social = docsSocialMetadata(found.page);
    expect(social.openGraph).toMatchObject({
      url: "/docs/webhooks/verify",
      siteName: "Vestiarion",
      images: [{ url: "/og/docs/webhooks/verify", width: 1200, height: 630 }],
    });
    expect(social.twitter).toMatchObject({ card: "summary_large_image", images: [{ url: "/og/docs/webhooks/verify" }] });
    expect(docsImagePath("")).toBe("/og/docs");
  });
});

describe("proxy matcher", () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url: path });

  it.each(["/opengraph-image", "/twitter-image", "/og/docs", "/og/docs/api/get-status"])("skips the social image %s", (path) => {
    expect(matches(path)).toBe(false);
  });

  it.each(["/", "/docs/webhooks/verify", "/o/acme/console"])("still runs on the page %s", (path) => {
    expect(matches(path)).toBe(true);
  });
});
