import type { NextConfig } from "next";
import { legacyRedirects } from "./src/lib/auth/org-paths";

const nextConfig: NextConfig = {
  async redirects() {
    return legacyRedirects();
  },
};

export default nextConfig;
