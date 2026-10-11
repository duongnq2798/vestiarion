import type { Metadata } from "next";
import { BuildOnIt } from "@/components/landing/BuildOnIt";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { Faq } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { Proof } from "@/components/landing/Proof";
import { landingProvenance, latestOwnPaymentUrl } from "@/components/landing/provenance";
import { Safety } from "@/components/landing/Safety";
import { Steps } from "@/components/landing/Steps";
import { UseCases } from "@/components/landing/UseCases";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { chainModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { currentConfig } from "@/lib/context";
import { withFoundingOrg } from "@/lib/dal/scope";
import { mainnetOpenToEveryone } from "@/lib/mainnet";
import { ARC_MAINNET } from "@/lib/network";
import { readLatestDecision } from "@/lib/platform/latest-decision";
import { readAllTimeOrNull } from "@/lib/platform/open-numbers";
import { reserveRunsLive } from "@/lib/platform/usyc-reserve";
import { publicOrigin } from "@/lib/public-origin";
import { X_HANDLE } from "@/lib/site-links";

export const dynamic = "force-dynamic";

const TITLE = "Vestiarion — An accounts payable agent for small teams";
const DESCRIPTION =
  "Vestiarion's agent checks every invoice from your contractors and suppliers, says pay, wait or stop and why, and pays in USDC within the limits you set. Try it on your real bills in shadow mode, with no wallet or funds to start.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    type: "website",
    siteName: "Vestiarion",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    title: TITLE,
    description: "Every bill checked before it's paid, every decision on record. Try the agent on your real bills in shadow mode.",
  },
};

/**
 * What the page is, for search engines (landing clarity M2): the product as a web application, with no price, since
 * none is published.
 */
function structuredData(): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Vestiarion",
    url: `${publicOrigin()}/`,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: DESCRIPTION,
  }).replace(/</g, "\\u003c");
}

/**
 * Whether any live workspace runs a real USYC reserve; false when that cannot be read, so the proof says simulated
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
 * The landing page (docs/superpowers/specs/2026-10-11-landing-clarity-design.md): what Vestiarion is and how to try it
 * first, who it is for, how it is kept safe, then the proof, the developer's way in, the questions and the close. The
 * technical showcase, the decision loop step by step and the receipts behind each claim, is /how-it-decides.
 *
 * The public showcase reads the founding organization, named explicitly: a sandbox organization's demo data must never
 * inflate its "live" figures. The measurements are the open numbers, every workspace's, read through the aggregate
 * functions one network at a time (landing proof P3); Arc testnet's stream in behind their own skeleton, and Arc
 * mainnet's are read before the page renders, since the payments leg links to the team's latest payment there (P2).
 */
export default async function LandingPage() {
  const mainnet = readAllTimeOrNull("arc-mainnet");
  const testnet = readAllTimeOrNull("arc-testnet");
  // chainModes() still answers when the Circle credentials cannot be read (R12).
  const [modes, latest, reserveLive, mainnetNumbers] = await Promise.all([
    withFoundingOrg(async () => chainModes()),
    readLatestDecision(),
    reserveLiveAnywhere(),
    mainnet,
  ]);
  const provenance = landingProvenance({
    paymentsLive: modes.mode === "live",
    foundingReserveLive: modes.earnMode === "live",
    reserveRunsLive: reserveLive,
    screeningLive: screeningMode() === "live",
    mainnetTxUrl: latestOwnPaymentUrl(mainnetNumbers, ARC_MAINNET),
  });

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <SiteHeader landing />

      <main id="main">
        <Hero />
        <Steps />
        <UseCases />
        <Safety />
        <Proof
          numbers={testnet.then((testnetNumbers) => ({ mainnet: mainnetNumbers, testnet: testnetNumbers }))}
          latest={latest}
          provenance={provenance}
        />
        <BuildOnIt />
        <BuiltWith />
        <Faq mainnetForEveryone={mainnetOpenToEveryone(currentConfig())} />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}
