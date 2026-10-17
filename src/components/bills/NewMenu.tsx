"use client";

import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { ChevronDown, FilePlus2, FileSpreadsheet, FileText, Handshake, Plus, ReceiptText, Repeat } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { DealForm } from "@/components/deals/DealForm";
import BillImport from "@/components/intake/BillImport";
import InvoiceDocumentIntake from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake, { type IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import RecurringPayableIntake from "@/components/intake/RecurringPayableIntake";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { cn } from "@/components/ui/cn";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { dialogMotion, dialogPanel, overlayBackdrop } from "@/components/ui/overlay";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { orgHref } from "@/lib/auth/org-paths";
import type { ImportWorkspace } from "@/lib/bill-import/rows";
import { billsHref, readBillsQuery, type NewKind } from "@/lib/bills-view";
import { newItemsFor } from "./new-items";
import { withParam } from "./panel-history";

const ICONS: Record<NewKind, ReactNode> = {
  bill: <FilePlus2 aria-hidden />,
  invoice: <ReceiptText aria-hidden />,
  document: <FileText aria-hidden />,
  import: <FileSpreadsheet aria-hidden />,
  recurring: <Repeat aria-hidden />,
  deal: <Handshake aria-hidden />,
};

/** Asks New ▾ to open one of its forms, from a button elsewhere on the page (an empty list's Add a bill). */
export const OPEN_NEW_EVENT = "bills:new";

export interface NewMenuProps {
  orgSlug: string;
  counterparties: IntakeCounterparty[];
  /** The business's own currency in shadow mode. */
  billCurrency?: string;
  importWorkspace: ImportWorkspace;
  /** What New deal needs, where deals are set up; null hides Deal. */
  deal: { customers: Array<{ id: string; name: string }>; currencies: string[]; idempotencyKey: string; today: string } | null;
  /** The workspace's active projects, for Bill to pay (project budgets P3); null before projects are set up. */
  projects?: Array<{ id: string; name: string }> | null;
}

/** Where "Show it" goes after a save: the newest first, in the tab that lists it. */
function afterSaveHref(kind: NewKind, direction: string | null): string {
  if (kind === "recurring") return billsHref({ tab: "bills", filter: "recurring" });
  const receivable = kind === "invoice" ? direction !== "payable" : direction === "receivable";
  return billsHref({ tab: receivable ? "receivables" : "bills", filter: "all", sort: "added" });
}

const SAVED_WORDS: Record<NewKind, { text: string; link: string }> = {
  bill: { text: "Added.", link: "Show it in the list" },
  invoice: { text: "Added.", link: "Show it in the list" },
  document: { text: "Added.", link: "Show it in the list" },
  import: { text: "Imported.", link: "Show them in the list" },
  recurring: { text: "Schedule set up.", link: "Show recurring bills" },
  deal: { text: "Saved.", link: "Show deals" },
};

/**
 * New ▾ on Bills & receivables (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B13): each item opens the form
 * it always was in a sheet, with its own checks, permissions and server action. Once anything is typed, closing asks
 * first, and so does leaving the page. After a save it says what happened and where the new row is; it never says a bill
 * is paid or approved. `?new=<kind>` and the palette's `?add` open a form as the page arrives.
 */
export function NewMenu({ orgSlug, counterparties, billCurrency, importWorkspace, deal, projects }: NewMenuProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [kind, setKind] = useState<NewKind | null>(null);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState(false);
  const direction = useRef<string | null>(null);
  // After a save the form clears itself, and a select returning to its default reports a "change" (Radix's hidden
  // native select element dispatches one): that is not the person editing. Until they type again (an "input"), a change
  // alone leaves the form clean, so leaving the page does not ask about what was just added.
  const settled = useRef(false);
  const edited = useCallback((event: SyntheticEvent) => {
    if (event.type === "input" || event.type === "drop") settled.current = false;
    else if (settled.current) return;
    setDirty(true);
  }, []);
  const items = useMemo(() => newItemsFor(deal), [deal]);
  const item = items.find((candidate) => candidate.kind === kind) ?? null;

  const open = useCallback((next: NewKind) => {
    setDirty(false);
    setSaved(false);
    settled.current = false;
    direction.current = null;
    setKind(next);
  }, []);
  const close = () => {
    setKind(null);
    setDirty(false);
    setAsking(false);
    setSaved(false);
    settled.current = false;
  };
  const onSaved = useCallback(() => {
    settled.current = true;
    setDirty(false);
    setSaved(true);
  }, []);

  // A form asked for in the address (the palette's Add a bill, a link): opened once, then taken out of the address.
  const asked = readBillsQuery(Object.fromEntries(searchParams.entries())).new;
  const [lastAsked, setLastAsked] = useState<NewKind | null>(null);
  if (asked !== lastAsked) {
    setLastAsked(asked);
    if (asked !== null && (asked !== "deal" || deal !== null)) {
      setKind(asked);
      setDirty(false);
      setSaved(false);
    }
  }
  useEffect(() => {
    if (asked === null) return;
    const search = withParam(withParam(window.location.search, "new", null), "add", null);
    window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [asked]);

  // An empty list's Add a bill, Import a list.
  useEffect(() => {
    const onAsk = (event: Event) => {
      const asked = (event as CustomEvent<NewKind>).detail;
      if (items.some((candidate) => candidate.kind === asked)) open(asked);
    };
    window.addEventListener(OPEN_NEW_EVENT, onAsk);
    return () => window.removeEventListener(OPEN_NEW_EVENT, onAsk);
  }, [items, open]);

  // Leaving the page with something typed asks first.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button icon={<Plus aria-hidden />}>
            New
            <ChevronDown aria-hidden className="-mr-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          {items.map((entry, index) => (
            <Fragment key={entry.kind}>
              {(entry.kind === "document" || entry.kind === "recurring") && index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => open(entry.kind)}>
                {ICONS[entry.kind]}
                {entry.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet
        open={item !== null}
        onOpenChange={(next) => {
          if (next) return;
          if (dirty) setAsking(true);
          else close();
        }}
      >
        {item && (
          <SheetContent
            side="right"
            title={item.title}
            description={item.description}
            className={cn("w-full max-w-none", item.wide ? "sm:w-[min(56rem,calc(100vw-2rem))]" : "sm:w-[min(40rem,calc(100vw-2rem))]")}
          >
            <div
              className="space-y-4 px-5 py-5"
              onInputCapture={edited}
              onChangeCapture={edited}
              onDropCapture={edited}
              onSubmitCapture={(event) => {
                const value = new FormData(event.target as HTMLFormElement).get("direction");
                direction.current = typeof value === "string" ? value : direction.current;
              }}
            >
              {saved && (
                <Callout role="status">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{SAVED_WORDS[item.kind].text}</span>
                    <Button
                      variant="link"
                      onClick={() => {
                        const href = orgHref(orgSlug, afterSaveHref(item.kind, direction.current));
                        close();
                        router.push(href, { scroll: false });
                      }}
                    >
                      {SAVED_WORDS[item.kind].link}
                    </Button>
                  </span>
                </Callout>
              )}
              <NewForm
                kind={item.kind}
                orgSlug={orgSlug}
                counterparties={counterparties}
                billCurrency={billCurrency}
                importWorkspace={importWorkspace}
                deal={deal}
                projects={projects}
                onSaved={onSaved}
              />
            </div>
          </SheetContent>
        )}
      </Sheet>

      <AlertDialogPrimitive.Root open={asking} onOpenChange={setAsking}>
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay data-overlay-backdrop="" className={overlayBackdrop} />
          <AlertDialogPrimitive.Content className={cn(dialogPanel, dialogMotion, "max-w-md")}>
            <AlertDialogPrimitive.Title className="text-base font-semibold text-ink">Discard what you entered?</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Nothing was added. Closing the form loses what you typed.
            </AlertDialogPrimitive.Description>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="secondary">Keep editing</Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button variant="danger-solid" onClick={close}>
                  Discard
                </Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </>
  );
}

function NewForm({
  kind,
  orgSlug,
  counterparties,
  billCurrency,
  importWorkspace,
  deal,
  projects,
  onSaved,
}: Omit<NewMenuProps, "orgSlug"> & { kind: NewKind; orgSlug: string; onSaved: () => void }) {
  switch (kind) {
    case "bill":
      return <InvoiceIntake orgSlug={orgSlug} counterparties={counterparties} billCurrency={billCurrency} initialDirection="payable" projects={projects} onAdded={onSaved} />;
    case "invoice":
      return <InvoiceIntake orgSlug={orgSlug} counterparties={counterparties} billCurrency={billCurrency} initialDirection="receivable" onAdded={onSaved} />;
    case "document":
      return <InvoiceDocumentIntake orgSlug={orgSlug} counterparties={counterparties} onAdded={onSaved} />;
    case "import":
      return <BillImport orgSlug={orgSlug} workspace={importWorkspace} onImported={onSaved} />;
    case "recurring":
      return <RecurringPayableIntake orgSlug={orgSlug} counterparties={counterparties} onSaved={onSaved} />;
    case "deal":
      return deal ? <DealForm orgSlug={orgSlug} customers={deal.customers} currencies={deal.currencies} idempotencyKey={deal.idempotencyKey} today={deal.today} /> : null;
  }
}

/** A button elsewhere on the page that opens one of New ▾'s forms. */
export function NewButton({ kind, children, variant = "primary" }: { kind: NewKind; children: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Button variant={variant} icon={ICONS[kind]} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_NEW_EVENT, { detail: kind }))}>
      {children}
    </Button>
  );
}
