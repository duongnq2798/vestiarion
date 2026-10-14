"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";

/** The HubSpot deal whose Plan collections form was just sent, kept for the page that comes back from it. */
const JUST_PLANNED = "vx:planned-from-crm";

/**
 * The Plan collections form filled in from a CRM's won deal (HubSpot connector H11), remembering it was sent: the page
 * that comes back once the deal is planned finds that deal planned, and goes on to the new deal (B4 of the Bills &
 * receivables tabs design, found in a live test).
 */
export function PlanFromCrmForm({ rowId, children }: { rowId: string; children: ReactNode }) {
  return (
    <div
      onSubmitCapture={() => {
        try {
          window.sessionStorage.setItem(JUST_PLANNED, JSON.stringify({ rowId, at: Date.now() }));
        } catch {
          // No storage: the page says the deal is planned and links it instead.
        }
      }}
    >
      {children}
    </div>
  );
}

/** Whether this page comes back from planning this deal, a moment ago: read once, then forgotten. */
function justPlanned(rowId: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(JUST_PLANNED);
    if (!raw) return false;
    window.sessionStorage.removeItem(JUST_PLANNED);
    const sent = JSON.parse(raw) as { rowId?: string; at?: number };
    return sent.rowId === rowId && typeof sent.at === "number" && Date.now() - sent.at < 5 * 60_000;
  } catch {
    return false;
  }
}

/**
 * A CRM deal the address asks to plan (`?hubspot=<row>`, `?pipedrive=<row>`) that is planned already: never an error, but the deal it
 * became, with Open the deal. Right after its own Plan collections, the page goes on to that deal; either way the
 * address stops asking, so a refresh shows Receivables as it is.
 */
export function PlannedFromCrm({ rowId, title, dealHref, cancelled = false }: { rowId: string; title: string; dealHref: string; cancelled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (justPlanned(rowId)) {
      router.replace(dealHref);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (!params.has("hubspot") && !params.has("pipedrive")) return;
    params.delete("hubspot");
    params.delete("pipedrive");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [rowId, dealHref, router]);

  return (
    <Callout tone={cancelled ? "neutral" : "proof"} role="status" className="mb-6">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Already planned: {title}
          {cancelled ? ", cancelled since" : ""}.
        </span>
        <Button asChild variant="link">
          <Link href={dealHref}>Open the deal</Link>
        </Button>
      </span>
    </Callout>
  );
}
