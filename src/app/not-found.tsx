import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/** Any address that matches no page. Workspace addresses have their own, in `o/not-found.tsx`. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md text-center">
          <p>
            <Eyebrow className="text-agent">404</Eyebrow>
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">This page does not exist</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">The address may be mistyped, or the page may have moved.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild>
              <Link href="/onboarding">Open console</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/">Go to the homepage</Link>
            </Button>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
