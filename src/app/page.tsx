import type { Metadata } from "next";
import { Claims } from "@/components/landing/Claims";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { Credentials } from "@/components/landing/Credentials";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LatestDecision } from "@/components/landing/LatestDecision";
import { LiveProof } from "@/components/landing/LiveProof";
import { landingProvenance, latestOwnPaymentUrl } from "@/components/landing/provenance";
import { WhatItPays } from "@/components/landing/WhatItPays";
import type { ChainHeadEntry } from "@/components/landing/hero/EvidenceReplay";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { chainModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { hostedWalletsAvailable } from "@/lib/config";
import { currentConfig } from "@/lib/context";
import { withFoundingOrg } from "@/lib/dal/scope";
import { listLedgerEntries } from "@/lib/ledger";
import { ARC_MAINNET } from "@/lib/network";
import { readLatestDecision } from "@/lib/platform/latest-decision";
import { readAllTimeOrNull } from "@/lib/platform/open-numbers";
import { reserveRunsLive } from "@/lib/platform/usyc-reserve";
import { X_HANDLE } from "@/lib/site-links";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vestiarion — Verifiable Treasury Agent on Arc",
  description: "A treasury agent that screens counterparties, pays obligations, applies code-level guardrails, and signs every decision into an auditable chain on Arc.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "See the live console, measured outcomes on Arc, and the signed decision ledger behind an autonomous business treasury.",
    url: "/",
    type: "website",
    siteName: "Vestiarion",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
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
 * Whether any live workspace runs a real USYC reserve; false when that cannot be read, so the hero says simulated
 * rather than claiming a reserve it could not see.
 */
async function reserveLiveAnywhere(): Promise<boolean> {
  try {
    return await reserveRunsLive();
  } catch (error) {
    console.error("landing: USYC reserve count not read", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * The public showcase reads the founding organization, named explicitly: a
 * sandbox organization's demo data must never inflate its "live" figures.
 * Every read starts here, inside that scope, and the sections take the
 * results as props. The measurements are the open numbers, every workspace's, read through the aggregate functions
 * one network at a time (landing proof P3); Arc testnet's stream in behind their own skeleton, and Arc mainnet's are
 * read before the hero, whose payments leg links to the team's latest payment there (P2).
 */
export default async function LandingPage() {
  const mainnet = readAllTimeOrNull("arc-mainnet");
  const testnet = readAllTimeOrNull("arc-testnet");
  // chainModes() still answers when the Circle credentials cannot be read (R12).
  // The team's latest decision is read before the page renders, so the band never pushes the page down after it (L2).
  const [modes, head, latest, reserveLive, mainnetNumbers] = await Promise.all([
    withFoundingOrg(async () => chainModes()),
    chainHead(),
    readLatestDecision(),
    reserveLiveAnywhere(),
    mainnet,
  ]);
  const currentScreeningMode = screeningMode();
  // The platform's config, outside any organization's scope: a boolean only, never the pair (R4).
  const hostedAvailable = hostedWalletsAvailable(currentConfig());
  const provenance = landingProvenance({
    paymentsLive: modes.mode === "live",
    foundingReserveLive: modes.earnMode === "live",
    reserveRunsLive: reserveLive,
    screeningLive: currentScreeningMode === "live",
    mainnetTxUrl: latestOwnPaymentUrl(mainnetNumbers, ARC_MAINNET),
  });

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <SiteHeader landing />

      <main id="main">
        <Hero provenance={provenance} head={head} hostedAvailable={hostedAvailable} />
        <LatestDecision decision={latest} />
        <WhatItPays />
        <Credentials screeningMode={currentScreeningMode} />
        <BuiltWith />
        <LiveProof numbers={testnet.then((testnetNumbers) => ({ mainnet: mainnetNumbers, testnet: testnetNumbers }))} />
        <HowItWorks />
        <Claims />
        <FinalCta hostedAvailable={hostedAvailable} />
      </main>

      <SiteFooter />
    </div>
  );
}
