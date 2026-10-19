import type { Metadata } from "next";
import { BuildOnIt } from "@/components/landing/BuildOnIt";
import { BillJourney } from "@/components/landing/BillJourney";
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
import { readRecentDecisions } from "@/lib/platform/recent-decisions";
import { readTeamJourneys } from "@/lib/platform/team-journeys";
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
 * The bill's journey: a clear application view and the same team's recorded bill through its checks, decision and
 * payment, followed by how to start, the controls, public measurements, integrations, developer entry and questions.
 *
 * The synchronous shell never waits for evidence. Hero and journey share one sanitized read; independent boundaries
 * stream the numbers, latest signed decision and recent decisions without delaying the positioning or calls to action.
 */
export default function LandingPage() {
  const mainnet = readAllTimeOrNull("arc-mainnet");
  const testnet = readAllTimeOrNull("arc-testnet");
  const numbers = Promise.all([mainnet, testnet]).then(([mainnetNumbers, testnetNumbers]) => ({ mainnet: mainnetNumbers, testnet: testnetNumbers }));
  const journey = readTeamJourneys();
  const recent = readRecentDecisions();

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <SiteHeader landing />

      <main id="main">
        <Hero journey={journey} />
        <BillJourney source={journey} />
        <Steps />
        <UseCases />
        <Safety />
        <Proof numbers={numbers} facts={proofFacts()} recent={recent} />
        <Integrations />
        <BuildOnIt />
        <Faq mainnetForEveryone={mainnetOpenToEveryone(currentConfig())} />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}
