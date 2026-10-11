import type { MetadataRoute } from "next";

/**
 * Served at /manifest.webmanifest. The icons come from
 * `scripts/build-icons.mjs`; the colours are the product's surface and ground.
 *
 * `minimal-ui`, not `standalone`: sign-in is an emailed link. On iOS a
 * standalone home-screen app keeps its own cookie jar, the link opens in
 * Safari, and the person would be signed in everywhere except the app they
 * installed. Chromium still installs a `minimal-ui` app, sharing the browser's
 * session, and iOS opens it as a Safari tab.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Vestiarion — Accounts payable agent for small teams",
    short_name: "Vestiarion",
    description:
      "An accounts payable agent for small teams: it checks every bill before it is paid, pays in USDC within the limits you set, and signs every decision into a record you can verify.",
    start_url: "/onboarding",
    scope: "/",
    display: "minimal-ui",
    background_color: "#f3f0e7",
    theme_color: "#fffefa",
    categories: ["finance", "business"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
