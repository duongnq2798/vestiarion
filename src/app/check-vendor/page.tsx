import type { Metadata } from "next";
import Link from "next/link";
import { PublicMain } from "@/components/public/PublicMain";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { VendorCheckCta } from "@/components/vendor-check/VendorCheckCta";
import { VendorChecker } from "@/components/vendor-check/VendorChecker";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import wallets from "@/lib/data/ofac-sdn-evm-wallets.json";
import { GITHUB_URL, X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "OFAC check for vendors: one name or a whole list, free";
const SOCIAL_TITLE = "Free OFAC check for vendors: one name or a whole list";
const DESCRIPTION =
  "Check a vendor's name, or your whole vendor list with its wallet addresses, against OFAC's SDN list. Each possible match says why it matched, with a link to Treasury's own search, and the results come back as a CSV. Free, no sign-up, and nothing you paste leaves your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/check-vendor" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/check-vendor", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/**
 * The SDN list's date as the page writes it: "Oct 28, 2026", and as the CSV writes it: "2026-10-28". Read from the
 * wallet snapshot, which the script writes from the same download on the same day (tests/sanctioned-names.test.ts
 * holds the two dates to each other), so the server page does not carry the 2 MB name snapshot for one date.
 */
const listDate = utcDay(wallets.readAt);
const listDay = wallets.readAt.slice(0, 10);

const TREASURY_SEARCH = "https://sanctionssearch.ofac.treas.gov/";
const REFRESH_SCRIPT = `${GITHUB_URL}/blob/main/scripts/ofac-sdn-wallets.mjs`;

/**
 * /check-vendor (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV8): a free page that checks a vendor, or a
 * whole vendor list, against OFAC's SDN list. Static: the check runs in the browser against the dated snapshot it loads
 * when a check runs, so no name or address reaches the server. Not under /tools, which serves downloads.
 */
export default function CheckVendorPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Free tool</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Check your vendors against OFAC&apos;s sanctions list</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Type a vendor&apos;s name, or paste your whole vendor list. Each name is compared with every name on OFAC&apos;s SDN list, the US
            Treasury&apos;s list of sanctioned people and companies, other names included, and each wallet address with the addresses the list
            gives and with the rest of your list. You see each possible match and why it matched, and you can download the results as a CSV.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            The check runs in this page. Nothing you type or paste is sent anywhere or kept. OFAC&apos;s SDN list as of {listDate}.
          </p>

          <div className="mt-10">
            <VendorChecker listDate={listDate} listDay={listDay} />
          </div>

          <section aria-labelledby="covers" className="mt-14 border-t border-line pt-8">
            <h2 id="covers" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What this check covers, and what it does not
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                It covers OFAC&apos;s SDN list only, the Specially Designated Nationals and Blocked Persons list: not OFAC&apos;s other (non-SDN)
                lists, gathered in its Consolidated Sanctions List, and not the EU&apos;s, the UN&apos;s or the UK&apos;s sanctions lists.
              </li>
              <li>
                It compares names and the addresses the list gives. It does not know who owns a company: OFAC also blocks a company owned 50 percent
                or more, together, by parties on the list, even when the company is not on it. It does not look at a wallet&apos;s history.
              </li>
              <li>
                A match is a reason to look closer: compare the entry&apos;s details with what you know of the vendor, and look it up on{" "}
                <a href={TREASURY_SEARCH} target="_blank" rel="noopener noreferrer" className="font-medium text-agent underline-offset-4 hover:underline">
                  Treasury&apos;s own search
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                . No match does not prove a vendor is not on the list: a name can be written many ways.
              </li>
              <li>It is a first look, not a compliance decision.</li>
              <li>
                The list here is OFAC&apos;s of {listDate}. It is refreshed from OFAC&apos;s files by a{" "}
                <a href={REFRESH_SCRIPT} target="_blank" rel="noopener noreferrer" className="font-medium text-agent underline-offset-4 hover:underline">
                  script in Vestiarion&apos;s open-source code
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                .
              </li>
            </ul>
          </section>

          <section aria-labelledby="how" className="mt-10">
            <h2 id="how" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              How names are compared
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Word by word, in any order, with accents, capitals, punctuation and legal forms such as LLC, Ltd or GmbH set aside. A word counts for
              more the rarer it is on the list, so a shared &ldquo;trading&rdquo; or &ldquo;group&rdquo; counts for little. A word spelled another
              way, such as Hezbollah for Hizballah, counts for nine tenths of the same word. A word only close to one, such as Kadhafi for Qadhafi,
              counts for between half and nine tenths of it, so a name written another way may come out a possible match rather than a strong one. A
              name made only of words that are rare on the list, such as Suex, is a possible match at least to a listed name holding them all. OFAC
              writes every name in Latin letters, so words in another script are not compared. A score of 0.85 or more is a strong match, the same
              cut-off Vestiarion&apos;s screening applies to its provider&apos;s score to call a sanctions match high risk; from 0.70 it is a possible
              match to review.
            </p>
          </section>

          <section aria-labelledby="in-a-workspace" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
            <h2 id="in-a-workspace" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What Vestiarion does before it pays
            </h2>
            <div className="mt-3">
              <VendorCheckCta />
            </div>
            <div className="mt-4">
              <Button asChild variant="secondary">
                <Link href="/docs/guides/first-payment#1-add-a-counterparty-with-an-arc-address">How screening works</Link>
              </Button>
            </div>
          </section>
        </div>
      </PublicMain>
      <SiteFooter />
    </div>
  );
}
