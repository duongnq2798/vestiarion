import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { STORE_URL } from "@/lib/extension/settings";

/**
 * Google's "Available in the Chrome Web Store" badge, the bordered version for a light ground, served as Google ships it
 * (developer.chrome.com/docs/webstore/branding): resized only, in proportion, and always linking to the extension's
 * page in the store. It is the one way Google lets a site show Chrome's logo without asking first, so the hero shows it
 * rather than Chrome's logo on a button of its own. The file is 340 x 96, drawn at half that, 170 x 48, so it is sharp
 * on a screen of twice the density and its words stay legible on one of single density.
 */
export const CHROME_WEB_STORE_BADGE = {
  src: "/badges/chrome-web-store.png",
  alt: "Available in the Chrome Web Store",
  width: 170,
  height: 48,
} as const;

export const INVOICE_CAPTURE_GUIDE = "/docs/guides/invoice-capture";

/**
 * Vestiarion Invoice Capture in the hero (docs/superpowers/specs/2026-10-16-landing-hero-capture-design.md): what the
 * extension does in a line, a link to its guide for everyone, and its store badge where it can be installed. Chrome
 * installs extensions on a computer, not on a phone or a tablet, so the badge shows only to a mouse or trackpad (a
 * fine primary pointer), in CSS, with no reading of the browser's name and nothing that changes once the page runs.
 * The extension saves a draft and nothing more, and the words say so.
 */
export function InvoiceCapture() {
  return (
    <div className="mt-6 max-w-xl border-t border-line pt-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-semibold text-ink">Capture invoices from your browser</p>
          <p className="mt-1 text-pretty text-[0.8125rem] leading-relaxed text-ink-2">
            A Chrome extension saves an invoice from any page or file to your workspace as a draft, for you to check and add.
          </p>
          <Link
            href={INVOICE_CAPTURE_GUIDE}
            className="mt-1 inline-flex min-h-6 items-center gap-1 text-[0.8125rem] font-medium text-agent underline-offset-2 hover:underline"
          >
            Learn about Invoice Capture
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
        <a
          href={STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-cta="hero-chrome"
          className="hidden shrink-0 self-start rounded-lg pointer-fine:inline-flex sm:self-center"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- Google's badge file as it ships; next/image would re-encode it */}
          <img
            src={CHROME_WEB_STORE_BADGE.src}
            alt={CHROME_WEB_STORE_BADGE.alt}
            width={CHROME_WEB_STORE_BADGE.width}
            height={CHROME_WEB_STORE_BADGE.height}
            decoding="async"
            draggable={false}
            className="block"
          />
          <span className="sr-only"> (Vestiarion Invoice Capture, opens in a new tab)</span>
        </a>
      </div>
    </div>
  );
}
