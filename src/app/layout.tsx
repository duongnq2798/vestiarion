import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "Vestiarion — Autonomous Treasury Agent",
  description:
    "An autonomous treasury agent that screens, pays, allocates, and signs every decision into a verifiable audit chain.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
