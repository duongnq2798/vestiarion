import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { STORE_URL } from "@/lib/extension/settings";

/**
 * Vestiarion Invoice Capture's own icon, the one the Chrome Web Store lists it with: a copy of the extension's 48 px
 * icon (extensions/chrome-invoice-capture/extension/icons/icon-48.png), drawn at 18 px. Chrome's logo is Google's, and
 * Google asks to be asked before a site draws it, so the button carries the extension's icon and names Chrome in words.
 */
export const EXTENSION_ICON = { src: "/extension/invoice-capture-48.png", size: 18 } as const;

export const INVOICE_CAPTURE_GUIDE = "/docs/guides/invoice-capture";

/**
 * Vestiarion Invoice Capture in the hero (docs/superpowers/specs/2026-10-16-landing-hero-capture-design.md): what the
 * extension does in a line, and one small way to it beside the words. Chrome installs extensions on a computer, not on a
 * phone or a tablet, so a mouse or trackpad (a fine primary pointer) gets Add to Chrome, and a touch screen the guide
 * instead, in CSS, with no reading of the browser's name and nothing that changes once the page runs. The extension
 * saves a draft and nothing more, and the words say so.
 */
export function InvoiceCapture() {
  return (
    // One row as wide as the column's text above: the words take the room left, the button keeps to the right edge.
    <div className="mt-8 flex max-w-xl flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-[0.9375rem] font-semibold text-ink">Capture invoices from Chrome</p>
        <p className="mt-0.5 text-pretty text-[0.8125rem] leading-relaxed text-ink-2">Send an invoice from any page to your workspace as a draft.</p>
      </div>
      <Button asChild size="sm" variant="secondary" className="hidden shrink-0 bg-surface/80 pointer-fine:inline-flex">
        <a href={STORE_URL} target="_blank" rel="noopener noreferrer" data-cta="hero-chrome">
          {/* eslint-disable-next-line @next/next/no-img-element -- a 48 px icon; next/image adds nothing */}
          <img src={EXTENSION_ICON.src} alt="" aria-hidden width={EXTENSION_ICON.size} height={EXTENSION_ICON.size} decoding="async" className="shrink-0" />
          Add to Chrome
          <ArrowUpRight aria-hidden />
          <span className="sr-only"> (Vestiarion Invoice Capture on the Chrome Web Store, opens in a new tab)</span>
        </a>
      </Button>
      <Link
        href={INVOICE_CAPTURE_GUIDE}
        prefetch={false}
        className="inline-flex min-h-6 items-center gap-1 text-[0.8125rem] font-medium text-agent underline-offset-2 hover:underline pointer-fine:hidden"
      >
        Learn about Invoice Capture
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}
