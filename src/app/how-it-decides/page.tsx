import type { Metadata } from "next";
import { Claims } from "@/components/landing/Claims";
import { DecidesHero } from "@/components/landing/DecidesHero";
import { FinalCta } from "@/components/landing/FinalCta";
import { HowItWorks } from "@/components/landing/HowItWorks";
import type { ChainHeadEntry } from "@/components/landing/hero/EvidenceReplay";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { screeningMode } from "@/lib/compliance";
import { withFoundingOrg } from "@/lib/dal/scope";
import { listLedgerEntries } from "@/lib/ledger";
import { X_HANDLE } from "@/lib/site-links";

export const dynamic = "force-dynamic";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "How the agent decides";
const SOCIAL_TITLE = "How Vestiarion's agent decides — the model proposes, code decides, every outcome is signed";
const DESCRIPTION =
  "The loop every payment runs: the agent reads the book, a model proposes, rules in code decide whether it may happen, and every outcome, refusals included, is signed into a hash-linked ledger anyone can verify.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/how-it-decides" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/how-it-decides", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/**
 * The founding organization's two newest ledger entries, reduced to what a public page may show: sequence, hash, domain
 * and action, never a summary or its detail. A ledger that cannot be read leaves the replay without its chain rather
 * than without the page.
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
 * /how-it-decides (docs/superpowers/specs/2026-10-11-landing-clarity-design.md D1): the technical showcase the landing
 * page links to for a reader who wants the mechanism, a decision receipt replayed beside the live ledger's head, the
 * decision loop step by step, and the claims with the receipts behind them.
 */
export default async function HowItDecidesPage() {
  const head = await chainHead();
  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <main id="main">
        <DecidesHero head={head} />
        <HowItWorks />
        <Claims screeningMode={screeningMode()} />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
