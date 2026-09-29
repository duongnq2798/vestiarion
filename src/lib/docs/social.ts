import type { Metadata } from "next";
import { docsHref } from "./paths";

/** Where the social image of the docs page at `slug` is served, by `app/og/docs/[[...slug]]/route.ts`. */
export function docsImagePath(slug: string): string {
  return slug ? `/og/docs/${slug}` : "/og/docs";
}


/**
 * The Open Graph and X metadata of a docs page, pointing at its own image.
 * A page's `openGraph` replaces the root layout's rather than merging with
 * it, so the site-wide fields are repeated here.
 */
export function docsSocialMetadata(page: { slug: string; title: string; description: string }): Pick<Metadata, "openGraph" | "twitter"> {
  const title = `${page.title} · Vestiarion docs`;
  const image = {
    url: docsImagePath(page.slug),
    width: 1200,
    height: 630,
    type: "image/png",
    alt: `${page.title}, Vestiarion developer docs: ${page.description}`,
  };
  return {
    openGraph: {
      title,
      description: page.description,
      url: docsHref(page.slug),
      siteName: "Vestiarion",
      type: "website",
      locale: "en_US",
      images: [image],
    },
    twitter: { card: "summary_large_image", title, description: page.description, images: [image] },
  };
}
