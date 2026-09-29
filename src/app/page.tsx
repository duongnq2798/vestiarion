import type { Metadata } from "next";
import { Claims } from "@/components/landing/Claims";
import { Credentials } from "@/components/landing/Credentials";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LiveProof } from "@/components/landing/LiveProof";
import type { ChainHeadEntry } from "@/components/landing/hero/EvidenceReplay";
import type { ProvenanceLeg } from "@/components/vx/Provenance";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { chainModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { hostedWalletsAvailable } from "@/lib/config";
import { currentConfig } from "@/lib/context";
import { withFoundingOrg } from "@/lib/dal/scope";
import { getLandingMetrics } from "@/lib/landing";
import { listLedgerEntries } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vestiarion — Verifiable Treasury Agent on Arc",
  description: "A treasury agent that screens counterparties, pays obligations, applies code-level guardrails, and signs every decision into an auditable chain on Arc testnet.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "See the live console, measured Arc testnet outcomes, and signed decision ledger behind an autonomous business treasury.",
    url: "/",
    type: "website",
    siteName: "Vestiarion",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "An autonomous treasury agent whose decisions, refusals, and evidence are inspectable.",
  },
};

/**
 * The founding organization's two newest ledger entries, reduced to what a
 * public page may show: sequence, hash, domain and action — never a summary
 * or its detail. A ledger that cannot be read leaves the hero without its
 * chain rather than without the page.
 */
async function chainHead(): Promise<ChainHeadEntry[]> {
  try {
    const entries = await withFoundingOrg(() => listLedgerEntries(2));
    return entries.map(({ seq, hash, domain, action }) => ({ seq, hash, domain, action }));
  } catch {
    return [];
  }
}

/**
 * The public showcase reads the founding organization, named explicitly: a
 * sandbox organization's demo data must never inflate its "live" figures.
 * Every read starts here, inside that scope, and the sections take the
 * results as props; the metrics stream in behind their own skeleton.
 */
export default async function LandingPage() {
  const metrics = withFoundingOrg(() => getLandingMetrics());
  // chainModes() still answers when the Circle credentials cannot be read (R12).
  const [modes, head] = await Promise.all([withFoundingOrg(async () => chainModes()), chainHead()]);
  const currentScreeningMode = screeningMode();
  // The platform's config, outside any organization's scope: a boolean only, never the pair (R4).
  const hostedAvailable = hostedWalletsAvailable(currentConfig());
  const provenance: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: modes.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: modes.earnMode === "live" },
    { label: "Screening", detail: currentScreeningMode === "live" ? "OpenSanctions" : "bundled list", live: currentScreeningMode === "live" },
  ];

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <SiteHeader landing />

      <main id="main">
        <Hero provenance={provenance} head={head} hostedAvailable={hostedAvailable} />
        <Credentials screeningMode={currentScreeningMode} />
        <LiveProof metrics={metrics} />
        <HowItWorks />
        <Claims />
        <FinalCta hostedAvailable={hostedAvailable} />
      </main>

      <SiteFooter />
    </div>
  );
}
