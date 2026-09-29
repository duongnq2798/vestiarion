import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { legacyRedirects } from "./src/lib/auth/org-paths";

const nextConfig: NextConfig = {
  async redirects() {
    return legacyRedirects();
  },
};

// The docs' MDX in `content/docs` is imported by the /docs pages, not routed,
// so `pageExtensions` stays the default. No remark or rehype plugins: code is
// highlighted by the `pre` component in mdx-components.tsx.
const withMDX = createMDX({});

export default withMDX(nextConfig);
