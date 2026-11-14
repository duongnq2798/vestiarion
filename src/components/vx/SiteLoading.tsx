import type { ReactNode } from "react";
import { PublicMain } from "@/components/public/PublicMain";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import { SITE_COLUMN, SiteFooter, SiteHeader } from "./SiteChrome";

/**
 * What a page outside a workspace shows while it gathers its data (docs/superpowers/specs/2026-11-14-loading-states-design.md
 * L8): the site's header, frame and spacing as the page draws them, with its title and first card held open, so it
 * lands without a jump. The header's own links are the page's to say, since they follow who is signed in.
 *
 * - `column`: one centred column, as onboarding, your account and the answer pages a link opens (an offer, a document
 *   request);
 * - `form` and `record`: a payee's or a customer's page, in `PublicMain` at its width;
 * - `wide`: a console of many rows, as the accountant's.
 */
export function SiteLoading({ shape, header = "page" }: { shape: "column" | "form" | "record" | "wide"; header?: "page" | "wide" | "column" }) {
  const body = (
    <>
      <p role="status" className="sr-only">
        Loading…
      </p>
      <Skeleton className="h-8 w-56 max-w-full" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <Card className="mt-8 p-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-3 h-5 w-3/5" />
        <Skeleton className="mt-5 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-4/5" />
      </Card>
      {shape === "wide" && (
        <Card className="mt-4 p-5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-3 h-5 w-2/5" />
          <Skeleton className="mt-5 h-4 w-full" />
        </Card>
      )}
    </>
  );

  let main: ReactNode;
  if (shape === "form" || shape === "record") {
    main = <PublicMain width={shape}>{busy(body)}</PublicMain>;
  } else if (shape === "wide") {
    main = (
      <main id="main" className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-8 sm:px-6 sm:py-12">
        {busy(body)}
      </main>
    );
  } else {
    main = (
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        {busy(body, cn("w-full", SITE_COLUMN))}
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader width={header} />
      {main}
      <SiteFooter compact />
    </div>
  );
}

function busy(body: ReactNode, className?: string) {
  return (
    <div aria-busy="true" className={className}>
      {body}
    </div>
  );
}
