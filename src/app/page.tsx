import type { Metadata } from "next";
import { Claims } from "@/components/landing/Claims";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LiveProof } from "@/components/landing/LiveProof";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vestiarion — Verifiable Treasury Agent on Arc",
  description: "A treasury agent that screens counterparties, pays obligations, applies code-level guardrails, and signs every decision into an auditable chain on Arc testnet.",
  openGraph: {
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "See the live console, measured Arc testnet outcomes, and signed decision ledger behind an autonomous business treasury.",
    type: "website",
    siteName: "Vestiarion",
  },
  twitter: {
    card: "summary",
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "An autonomous treasury agent whose decisions, refusals, and evidence are inspectable.",
  },
};

export default function LandingPage() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <SiteHeader landing />

      <main id="main">
        <Hero />
        <LiveProof />
        <HowItWorks />
        <Claims />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}
