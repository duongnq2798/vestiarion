import type { Metadata } from "next";
import Link from "next/link";
import { PayoutBatchChecker } from "@/components/payout-check/PayoutBatchChecker";
import { PublicMain } from "@/components/public/PublicMain";
import { ToolCta } from "@/components/public/ToolCta";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { FREE_TOOL_COUNT_LINE } from "@/lib/free-tools";
import { X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "Batch payout address check, free";
const SOCIAL_TITLE = "Payout batch check — lookalike addresses, rows sent twice and amounts to fix, before you send";
const DESCRIPTION =
  "Paste or drop a batch payout: a Safe CSV Airdrop file, a Disperse list or a sheet of payees and amounts. Every address is checked for hidden characters, its checksum and OFAC's list, and compared with every other in the batch, so one made to look like another payee's shows up. Amounts and tokens are read and totalled. Free, and nothing you paste leaves your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/check-payouts" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/check-payouts", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/** The OFAC list's date as the page writes it: "Oct 28, 2026" (CP1), as /check-vendor reads it from the same snapshot. */
const listDate = utcDay(snapshot.readAt);

/**
 * /check-payouts (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP1, CP12, CP13): a free page anyone can run
 * on a batch payout before sending it. Static: the batch is read and checked in the browser against the dated OFAC
 * snapshot the page carries, as /check-address does, so no address reaches the server. Not under /tools, which serves
 * downloads. Its start button is the shared `ToolCta`, and its footer names the tool, so both starts on the page credit a
 * workspace opened after them to this tool, from outside the checker's code
 * (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3, TA5, TA6).
 */
export default function CheckPayoutsPage() {
  const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Free tool</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Check a batch payout before you send it</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Paste your batch, or drop its file: a Safe CSV Airdrop file, a Disperse list, an exchange&apos;s batch withdrawal or a sheet of payees
            and amounts. Every address is checked for hidden characters, letters from another alphabet, its checksum and OFAC&apos;s sanctions
            list, and compared with every other address in the batch, so one made to look like another payee&apos;s shows up, the trick called
            address poisoning. It reads the amounts and the tokens too, and gives the file back with a verdict on each row.
          </p>
          {/* True whether analytics is set up or not (free tool attribution TA6). */}
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            The check runs in this page, and nothing you paste is kept. {FREE_TOOL_COUNT_LINE} OFAC&apos;s SDN list as of {listDate}.
          </p>

          <div className="mt-8">
            <PayoutBatchChecker sanctioned={sanctioned} listDate={listDate} />
          </div>

          <section aria-labelledby="how-it-works" className="mt-14 border-t border-line pt-8">
            <h2 id="how-it-works" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              How it works
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                It reads the file the way Vestiarion&apos;s bill import reads a list, and Safe&apos;s CSV Airdrop and Disperse lists as they are. It
                finds the address, name, amount and token columns by their names, and you can change any match.
              </li>
              <li>
                Each address gets the address checker&apos;s rules: hidden characters, letters from another alphabet that look like Latin ones, its
                length, its EIP-55 checksum, OFAC&apos;s list, and addresses that are not a wallet, such as a burn address or a USDC contract.
              </li>
              <li>
                Every address is compared with every other in the batch. Two that share at least 3 digits at each end, or 5 at one, are made to
                look alike, and both rows are told to stop: one of the two is very likely not the payee&apos;s. A long batch holds such pairs by
                chance, though: 5,000 addresses hold about two dozen sharing 5 digits at an end. So when a batch its size would hold a pair
                like it by chance more than once in 100 batches, both rows are to look at instead, saying how often chance does it. Two that
                share 4 digits at an end are rows to look at.
              </li>
              <li>
                It points out the same address on two rows, and one name with two addresses. Paste the addresses you have paid before, and each
                row is compared with them too.
              </li>
              <li>
                Each amount must be a number above zero, with no more decimals than its token has: 6 for USDC and EURC, 18 for a chain&apos;s own
                coin. An amount at least 100 times the median of the token&apos;s other amounts is one to look at. Each token&apos;s amounts are
                added up exactly.
              </li>
              <li>
                A token contract that is USDC or EURC on a chain Vestiarion knows is named. One made to look like it is a stop, and any other
                contract is one to look at.
              </li>
              <li>You can download your batch back, with a last column saying what was found on each row.</li>
            </ul>
          </section>

          <section aria-labelledby="does-not" className="mt-10">
            <h2 id="does-not" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What it does not do
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                It does not know who owns an address. Nothing found means none of these checks found anything on a row, not that the address is
                the payee&apos;s: confirm a new one with the payee, on a call or to a contact you already had.
              </li>
              <li>
                It does not look up ENS names, balances or an address&apos;s history, or exposure through mixers: it matches addresses on
                OFAC&apos;s list directly.
              </li>
              <li>It checks EVM (0x) addresses only, and the first 5,000 rows of a batch. It converts no amount.</li>
              <li>
                It does not pick what to pay, and sends nothing. For one address, use the{" "}
                <Link href="/check-address" className="font-medium text-agent underline underline-offset-4">
                  address lookalike checker
                </Link>
                ; for a vendor list&apos;s names, the{" "}
                <Link href="/check-vendor" className="font-medium text-agent underline underline-offset-4">
                  OFAC vendor check
                </Link>
                .
              </li>
            </ul>
          </section>

          <section aria-labelledby="check-payouts-in-vestiarion" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
            <h2 id="check-payouts-in-vestiarion" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What Vestiarion does with payouts
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Vestiarion locks each payee&apos;s payout address, checks it against OFAC&apos;s list and the payee&apos;s past addresses, and holds any
              payment whose address changes until someone confirms it, before it pays. It is an AI agent for bills and payments, and every step is
              signed into a ledger anyone can verify.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <ToolCta tool="check-payouts" />
              <Button asChild variant="secondary">
                <Link href="/docs/guides/first-payment#payee-lock">How the payee lock works</Link>
              </Button>
            </div>
            <p className="mt-3 text-sm text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
          </section>
        </div>
      </PublicMain>
      <SiteFooter tool="check-payouts" />
    </div>
  );
}
