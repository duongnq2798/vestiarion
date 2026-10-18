import type { Metadata } from "next";
import { BuildOnIt } from "@/components/landing/BuildOnIt";
import { Faq } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { Integrations } from "@/components/landing/Integrations";
import { Proof, type ProofFacts } from "@/components/landing/Proof";
import { Safety } from "@/components/landing/Safety";
import { Steps } from "@/components/landing/Steps";
import { UseCases } from "@/components/landing/UseCases";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { currentConfig } from "@/lib/context";
import { mainnetOpenToEveryone } from "@/lib/mainnet";
import { readLatestDecision } from "@/lib/platform/latest-decision";
import { readAllTimeOrNull } from "@/lib/platform/open-numbers";
import { publicOrigin } from "@/lib/public-origin";
import { X_HANDLE } from "@/lib/site-links";

export const dynamic = "force-dynamic";

const TITLE = "Vestiarion — Your AI agent for bills and payments";
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

/** What the proof shows besides the open numbers: the team's latest decision, its signature checked in the reader's browser. */
async function proofFacts(): Promise<ProofFacts> {
  return { latest: await readLatestDecision() };
}

/**
 * The landing page (docs/superpowers/specs/2026-10-11-landing-clarity-design.md): what Vestiarion is and how to try it
 * first, who it is for, how it is kept safe, then the proof, the tools it connects to, the developer's way in, the
 * questions and the close. The technical showcase, the decision loop step by step and the receipts behind each claim, is
 * /how-it-decides.
 *
 * Nothing above the proof waits for a read (landing stream S1): the reads start here and the proof streams each of them
 * in behind its own fallback, so the hero arrives with the first bytes. The measurements are the open numbers, every
 * workspace's, read through the aggregate functions one network at a time (landing proof P3).
 */
export default function LandingPage() {
  const mainnet = readAllTimeOrNull("arc-mainnet");
  const testnet = readAllTimeOrNull("arc-testnet");
  const numbers = Promise.all([mainnet, testnet]).then(([mainnetNumbers, testnetNumbers]) => ({ mainnet: mainnetNumbers, testnet: testnetNumbers }));

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <SiteHeader landing />

      <main id="main">
        <Hero />
        <Steps />
        <UseCases />
        <Safety />
        <Proof numbers={numbers} facts={proofFacts()} />
        <Integrations />
        <BuildOnIt />
        <Faq mainnetForEveryone={mainnetOpenToEveryone(currentConfig())} />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}
