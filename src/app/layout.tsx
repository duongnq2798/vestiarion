import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

const sans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const serif = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal"],
});

/**
 * Icons come from the file conventions beside this layout — favicon.ico,
 * icon.svg and apple-icon.png, rendered by `scripts/build-icons.mjs` — and
 * the web manifest from manifest.ts.
 */
export const metadata: Metadata = {
  title: {
    default: "Vestiarion — Autonomous Treasury Agent",
    template: "%s · Vestiarion",
  },
  description:
    "An autonomous treasury agent that screens, pays, allocates, and signs every decision into a verifiable audit chain.",
  applicationName: "Vestiarion",
  appleWebApp: { title: "Vestiarion" },
  // Amounts, hashes and sequence numbers must never turn into phone or address links.
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#fffefa",
  colorScheme: "light",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only rounded-lg bg-agent px-4 py-2.5 text-sm font-semibold text-on-agent focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
