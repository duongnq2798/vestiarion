import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { legacyRedirects } from "./src/lib/auth/org-paths";

const nextConfig: NextConfig = {
  // An invoice document of up to 4 MB is read through a Server Action
  // (src/app/actions/invoice-document.ts), with room for the multipart
  // overhead. The action refuses a larger file itself.
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },
  async redirects() {
    return legacyRedirects();
  },
  // Each docs page's Markdown view, `/docs.md` and `/docs/<slug>.md`, is served
  // by src/app/docs-md: the App Router has no suffix on a catch-all segment.
  // An array is applied after the pages, so a real page always wins; no docs
  // slug has a dot, and a `.md` that is not a page answers 404 from the route.
  // The route sends `X-Robots-Tag: noindex` itself; this covers the 404 Next
  // answers for a `/docs-md/…` path that is not a page, before the route runs.
  //
  // `/tools/:path*` is the standalone ledger verifier (audit-export fix
  // round 2): served as a download rather than run inline in the browser
  // tab someone reached it from, and not sniffed into running as anything
  // other than the plain script it is.
  async headers() {
    return [
      { source: "/docs-md/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
      {
        source: "/tools/:path*",
        headers: [
          { key: "Content-Disposition", value: "attachment" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/docs.md", destination: "/docs-md" },
      { source: "/docs/:path+\\.md", destination: "/docs-md/:path+" },
    ];
  },
};

// The docs' MDX in `content/docs` is imported by the /docs pages, not routed,
// so `pageExtensions` stays the default. Plugins are named by string, the
// form Turbopack can pass to its MDX loader: remark-gfm for tables. Code is
// highlighted by the `pre` component in mdx-components.tsx, not a plugin.
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
  },
});

export default withMDX(nextConfig);
