import type { Metadata } from "next";
import { LatestDecision } from "@/components/landing/LatestDecision";
import { LiveProof } from "@/components/landing/LiveProof";
import { GuidedSetupForm } from "@/components/studios/GuidedSetupForm";
import { Faq, GuidedSetup, Problem, Steps, StudiosFinalCta, StudiosHero, Trust } from "@/components/studios/StudiosSections";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { guidedSetupToken } from "@/lib/growth/guided-setup";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import { readLatestDecision } from "@/lib/platform/latest-decision";
import { readAllTimeOrNull } from "@/lib/platform/open-numbers";
import { masterKeysFromEnv } from "@/lib/secrets";
import { X_HANDLE } from "@/lib/site-links";

export const dynamic = "force-dynamic";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "For studios: check every contractor invoice before you pay it";
const SOCIAL_TITLE = "Vestiarion for studios — check every contractor invoice before you pay it";
const DESCRIPTION =
  "For studios that pay contractors per deliverable: an agent compares each invoice with what you agreed and what was delivered, says pay, wait or stop and why, and you approve.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/studios" },
  openGraph: {
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
    url: "/studios",
    type: "website",
    siteName: "Vestiarion",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
  },
};

/**
 * The guided setup form's token, signed as the page is drawn. Without a master key the form still shows, and its
 * action answers that something went wrong rather than dropping the request.
 */
function formToken(): string {
  try {
    return guidedSetupToken(masterKeysFromEnv());
  } catch (error) {
    console.error("studios: guided setup token not signed", error instanceof Error ? error.message : "unknown error");
    return "";
  }
}

/**
 * /studios: the use-case page for small studios that pay outside contractors per deliverable. Its figures are the
 * landing's, read the same way: the open numbers, all time, one network at a time and never added together, with
 * customers apart from the team (readAllTimeOrNull), and the team's latest signed decision. The trust block's count of
 * code refusals comes from the same numbers. No customer is named.
 */
export default async function StudiosPage() {
  const [mainnet, testnet, latest] = await Promise.all([readAllTimeOrNull("arc-mainnet"), readAllTimeOrNull("arc-testnet"), readLatestDecision()]);

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <SiteHeader />

      <main id="main">
        <StudiosHero />
        <Problem />
        <Steps />
        <Trust
          refusals={[
            { profile: ARC_MAINNET, numbers: mainnet },
            { profile: ARC_TESTNET, numbers: testnet },
          ]}
        />
        <LatestDecision decision={latest} />
        <LiveProof numbers={Promise.resolve({ mainnet, testnet })} />
        {/*
          Case study: a studio's story goes here, after the evidence, once that studio has agreed in writing to be named
          or described. Until then nothing is rendered: no customer names, logos or testimonials.
        */}
        <Faq />
        <GuidedSetup>
          <GuidedSetupForm token={formToken()} />
        </GuidedSetup>
        <StudiosFinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}
