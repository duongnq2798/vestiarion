import Link from "next/link";
import { TRY_HREF } from "@/components/landing/cta";
import { Button } from "@/components/ui/Button";

/**
 * The vendor check's call to action (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV9): what Vestiarion
 * does before it pays, the landing's "Try it on your bills", and the shadow-mode line. One file, so a call to action
 * shared by the free tools can take its place in one line.
 */
export function VendorCheckCta() {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-ink-2">
        Vestiarion screens every vendor and checks every pay-to wallet against OFAC&apos;s list before it pays, and never pays a vendor with a
        strong match.
      </p>
      <Button asChild>
        <Link href={TRY_HREF} data-cta="check-vendor-start">
          Try it on your bills
        </Link>
      </Button>
      <p className="text-sm leading-relaxed text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
    </div>
  );
}
