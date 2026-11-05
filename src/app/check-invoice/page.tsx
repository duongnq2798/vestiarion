import type { Metadata } from "next";
import Link from "next/link";
import { InvoiceChecker } from "@/components/invoice-check/InvoiceChecker";
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
const TITLE = "Invoice payment details check, free";
const SOCIAL_TITLE = "Invoice details check — catch changed bank details and lookalike senders before you pay";
const DESCRIPTION =
  "Put a vendor's payment details on file beside the ones on their new invoice: name, sender's email, phone, wallet, IBAN, account, routing or sort code and SWIFT. It shows what changed, a lookalike domain or wallet, a bad IBAN or routing number, and the words change requests use, then writes the call to make before you pay. Free, and nothing you type leaves your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/check-invoice" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/check-invoice", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/** The OFAC list's date as the page writes it: "Oct 28, 2026", read from the snapshot /check-address carries. */
const listDate = utcDay(snapshot.readAt);

/**
 * /check-invoice (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC1, IC8, IC9): a free page anyone can run
 * on an invoice's payment details before paying it. Static: the details are compared in the browser, and a wallet is
 * checked against the dated OFAC snapshot the page carries, so nothing typed reaches the server. Not under /tools, which
 * serves downloads. Its start button is the shared `ToolCta`, and its footer names the tool, so both starts on the page
 * credit a workspace opened after them to this tool (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md
 * TA3, TA5, TA6).
 */
export default function CheckInvoicePage() {
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
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Check an invoice&apos;s payment details before you pay it</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Many payments lost to fraud are not hacks. They are an invoice, or an email beside it, saying the vendor has new bank details. Put
            what you have on file for the vendor beside what the new invoice says, and paste the message that came with it. The page shows what
            changed, a sender or a wallet made to look like the vendor&apos;s, an IBAN or routing number that cannot be right, and the words such
            requests use. Then it writes the call to make before you pay.
          </p>
          {/* True whether analytics is set up or not (free tool attribution TA6). */}
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            Fill in what you have: a detail is compared when both sides are filled. The check runs in this page, and nothing you type is kept.{" "}
            {FREE_TOOL_COUNT_LINE} OFAC&apos;s SDN list as of {listDate}.
          </p>

          <div className="mt-8">
            <InvoiceChecker sanctioned={sanctioned} />
          </div>

          <section aria-labelledby="how-it-works" className="mt-14 border-t border-line pt-8">
            <h2 id="how-it-works" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              How it works
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                An IBAN, account number, routing or sort code or wallet that differs from the one on file is a reason to stop and call before you
                pay. So is one the invoice gives when none of the ways to be paid on file is on it. Beside one that matches, a new one is one to
                look at. A name, phone number, bank or SWIFT / BIC code that differs is one to look at, unless a new SWIFT / BIC moves an account
                number with no IBAN to another bank.
              </li>
              <li>
                The sender&apos;s domain is compared with the vendor&apos;s. One that looks like it is a stop: the same name under another ending,
                a word or a hyphen added, a letter or two changed, or letters that look alike, such as rn for m or l for i, and so is a domain in
                another alphabet. At a free mail service such as Gmail, the whole address is compared. A sender&apos;s name that is another
                email address is a stop. Any other domain is one to look at, and an invoice sent through a service such as Xero or QuickBooks is
                named as such.
              </li>
              <li>
                An IBAN is checked for its country&apos;s length and its check digits, a US routing number for its check digit, and a SWIFT / BIC
                code for its form. One that fails cannot be right as written: check what you typed, then ask the vendor. A detail on file that
                cannot be read is said too, so it never hides a change.
              </li>
              <li>
                A wallet gets the address checker&apos;s rules: hidden characters, its checksum, OFAC&apos;s list, and whether it is made to look
                like the one on file, the trick called address poisoning.
              </li>
              <li>
                The message is read for a request to change how you pay, and a Reply-To on another domain. Beside a change, it also points out
                pressure to pay quickly, a request not to call or to keep it quiet, and the reasons such requests give.
              </li>
              <li>
                The call script names what changed, tells you to call the number on file, never one from the invoice, and to let the vendor read
                the details out to you.
              </li>
            </ul>
          </section>

          <section aria-labelledby="does-not" className="mt-10">
            <h2 id="does-not" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What it does not do
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                It does not know who holds an account, a wallet or a domain, and looks nothing up: no bank, no domain records, no ENS. Nothing
                found means these checks found nothing, not that the invoice is the vendor&apos;s. A vendor&apos;s own mailbox can be broken into,
                so an email from the right domain can still ask for the wrong account.
              </li>
              <li>
                Your bank&apos;s payee name check, such as Confirmation of Payee in the UK, does know who holds an account: if it says the name does
                not match, do not pay.
              </li>
              <li>It does not read the invoice&apos;s file: type or paste its details.</li>
              <li>
                It keeps nothing between visits. For one wallet against the ones you know, use the{" "}
                <Link href="/check-address" className="font-medium text-agent underline underline-offset-4">
                  address lookalike checker
                </Link>
                ; for a vendor&apos;s name against OFAC&apos;s list, the{" "}
                <Link href="/check-vendor" className="font-medium text-agent underline underline-offset-4">
                  OFAC vendor check
                </Link>
                .
              </li>
            </ul>
          </section>

          <section aria-labelledby="check-invoice-in-vestiarion" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
            <h2 id="check-invoice-in-vestiarion" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What Vestiarion does when payment details change
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Vestiarion holds every payment to a payee whose address changed until a person confirms the new address; with the payee lock on,
              that takes a recorded check on a contact you had before. Once a workspace pays for real, it emails the payee&apos;s billing address on
              file to ask whether they made the change, and a payout to a bank account waits for a person every time. It is an AI agent for bills
              and payments, and every step is signed into a ledger anyone can check.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <ToolCta tool="check-invoice" />
              <Button asChild variant="secondary">
                <Link href="/docs/guides/first-payment#payee-lock">How the payee lock works</Link>
              </Button>
            </div>
            <p className="mt-3 text-sm text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
          </section>
        </div>
      </PublicMain>
      <SiteFooter tool="check-invoice" />
    </div>
  );
}
