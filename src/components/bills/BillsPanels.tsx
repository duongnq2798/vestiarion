"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { legacyHashHref, REVIEW_PANELS, type ReviewPanel } from "@/lib/bills-view";
import { closePanel, openPanel, takeOpener, type PanelKey } from "./panel-history";

/**
 * The panels over Bills & receivables (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B7, B11): a bill's detail,
 * which is its existing card with every action as before, and a review list (Xero, QuickBooks, bookings, email). The
 * address holds which one is open, so a refresh keeps it and Back closes it. Opening one sends nothing.
 */

export interface PanelContent {
  /** What a screen reader announces as the panel opens: "Pay Northwind Hosting". */
  title: string;
  node: ReactNode;
}

const PANEL_WIDTH = {
  detail: "w-full sm:w-[min(44rem,calc(100vw-2rem))]",
  review: "w-full sm:w-[min(48rem,calc(100vw-2rem))]",
} as const;

/** Unfolds and scrolls to a section of the open card that the address names: `#trail-<id>`, `#settlement-<id>`. */
function revealSection(id: string): void {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (hash !== `trail-${id}` && hash !== `settlement-${id}`) return;
  const target = document.getElementById(hash);
  if (!target) return;
  for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
  target.scrollIntoView({ block: "start", behavior: "instant" });
}

function Panel({ paramKey, items, width }: { paramKey: PanelKey; items: Record<string, PanelContent>; width: keyof typeof PANEL_WIDTH }) {
  const searchParams = useSearchParams();
  const asked = searchParams.get(paramKey);
  const valid = asked !== null && Object.hasOwn(items, asked) ? asked : null;
  // What is shown stays while the panel slides out, after the address no longer names it.
  const [shown, setShown] = useState<string | null>(valid);
  if (valid !== null && valid !== shown) setShown(valid);
  const content = shown !== null && Object.hasOwn(items, shown) ? items[shown] : null;
  const body = useRef<HTMLDivElement>(null);

  return (
    <Sheet open={valid !== null} onOpenChange={(open) => !open && closePanel(paramKey)}>
      {content && (
        <SheetContent
          side="right"
          title={content.title}
          hideHeader
          className={cn(PANEL_WIDTH[width], "max-w-none")}
          data-bills-panel={paramKey}
          onOpenAutoFocus={(event) => {
            // The panel itself takes focus, so its title is read first; Tab goes on into the card.
            event.preventDefault();
            body.current?.focus({ preventScroll: true });
            if (paramKey === "open" && shown) {
              const id = shown;
              requestAnimationFrame(() => revealSection(id));
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const back = takeOpener() ?? (shown ? document.querySelector<HTMLElement>(`[data-row-open="${CSS.escape(shown)}"]`) : null);
            back?.focus({ preventScroll: true });
          }}
        >
          <div ref={body} tabIndex={-1} className="px-3 pb-6 pt-14 outline-hidden sm:px-5">
            {content.node}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}

/** A bill's detail over the list: the card it always had. */
export function DetailPanel({ details }: { details: Record<string, PanelContent> }) {
  return <Panel paramKey="open" items={details} width="detail" />;
}

/** A review list over the page, opened from Waiting for review. */
export function ReviewPanels({ reviews }: { reviews: Partial<Record<ReviewPanel, PanelContent>> }) {
  return <Panel paramKey="review" items={reviews as Record<string, PanelContent>} width="review" />;
}

const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * A row's way into its detail: a link to the detail's address (a new tab, or no script, opens the page with it), which
 * opens the panel in place on a plain click. `stretched` makes the whole row its target, under the row's other links.
 */
export function RowLink({ id, href, children, stretched = false, className }: { id: string; href: string; children: ReactNode; stretched?: boolean; className?: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-haspopup="dialog"
      data-row-open={stretched ? id : undefined}
      onClick={(event) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        openPanel("open", id, event.currentTarget);
      }}
      className={cn(stretched && "after:absolute after:inset-0 after:content-['']", className)}
    >
      {children}
    </Link>
  );
}

/** One item of Waiting for review that opens its list over the page. */
export function ReviewButton({ review, children }: { review: ReviewPanel; children: ReactNode }) {
  return (
    <Button
      variant="link"
      className="text-[0.8125rem]"
      aria-haspopup="dialog"
      onClick={(event) => {
        if (REVIEW_PANELS.includes(review)) openPanel("review", review, event.currentTarget);
      }}
    >
      {children}
    </Button>
  );
}

/**
 * Rewrites a fragment from before the tabs (`#trail-<id>`, `#from-xero`, `#deals`…) into the address that shows it
 * (B4, `legacyHashHref`), once the page is loaded: the fragment never reached the server.
 */
export function LegacyHashRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const next = legacyHashHref(window.location.hash, window.location.search);
    if (next !== null) router.replace(`${pathname}${next}`, { scroll: false });
    // Once, as the page arrives: a fragment the page writes itself is already in the new form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
