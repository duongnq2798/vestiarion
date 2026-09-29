import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { legacyRedirects } from "./src/lib/auth/org-paths";

const nextConfig: NextConfig = {
  async redirects() {
    return legacyRedirects();
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
