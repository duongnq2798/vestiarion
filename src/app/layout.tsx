import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Vestiarion — Autonomous Treasury Agent",
  description:
    "An AI agent that runs a small business's treasury, AP/AR, contractor payments, and compliance screening on Arc, settled in USDC.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-100">
        <Nav />
        <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</main>
        <footer className="border-t border-neutral-800 px-6 py-4 text-center text-xs text-neutral-500">
          Vestiarion · Tameion Agents Hackathon · Canteen × Circle
        </footer>
      </body>
    </html>
  );
}
