"use client";

import { FilePlus2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { addXeroBillsAction, dismissXeroBillsAction, type XeroActionResult } from "@/app/actions/xero";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { ClosedRowView, ReviewRowView } from "@/lib/connectors/review";

const INITIAL: XeroActionResult = { ok: false, message: "" };
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 28", a bill's due day. */
function day(iso: string | null): string {
  if (!iso) return "no due date";
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

const CLOSED_WORDS: Record<string, string> = { paid: "paid in Xero", voided: "voided in Xero", deleted: "deleted in Xero" };

function Fate({ row }: { row: ReviewRowView }) {
  if (row.status === "add") {
    return (
      <span className="text-sm text-ink-2">
        Ready to add{row.usdc ? `, at ${AMOUNT.format(Number(row.usdc))} USDC` : ""}
        {row.supplierNew ? `, with ${row.supplier} as a new counterparty` : ""}
      </span>
    );
  }
  return <span className={row.status === "duplicate" ? "text-sm text-ink-3" : "text-sm text-refused"}>{row.reason}</span>;
}

function Act({
  action,
  orgSlug,
  connectionId,
  ids,
  goodsReceived,
  label,
  pendingLabel,
  icon,
  variant,
  onDone,
}: {
  action: typeof addXeroBillsAction;
  orgSlug: string;
  connectionId: string;
  ids: string[];
  goodsReceived?: boolean;
  label: string;
  pendingLabel: string;
  icon?: ReactNode;
  variant?: "secondary";
  onDone: (state: XeroActionResult) => void;
}) {
  const { formProps } = useActionForm(action, INITIAL, { toastOnSuccess: true, onResult: onDone });
  return (
    <form {...formProps}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="connectionId" value={connectionId} />
      {goodsReceived !== undefined && <input type="hidden" name="goodsReceived" value={String(goodsReceived)} />}
      {ids.map((id) => (
        <input key={id} type="hidden" name="billId" value={id} />
      ))}
      <SubmitButton size="sm" variant={variant} pendingLabel={pendingLabel} icon={icon} disabled={ids.length === 0}>
        {label}
      </SubmitButton>
    </form>
  );
}

/**
 * The bills Xero brought in, waiting for a person (docs/superpowers/specs/2026-10-12-xero-connector-design.md X11,
 * X19): each with its supplier, number, amount, due day and fate under the bill list's own check. Nothing becomes a
 * payable until someone who adds records ticks it and adds it, saying whether its goods or services were received; a
 * bill can be dismissed instead. Below, the bills already added that Xero since says were paid, voided or deleted.
 */
export function XeroBillsReview({
  orgSlug,
  connectionId,
  organisation,
  items,
  closed,
  canAdd,
}: {
  orgSlug: string;
  connectionId: string;
  organisation: string | null;
  items: ReviewRowView[];
  closed: ClosedRowView[];
  canAdd: boolean;
}) {
  const addable = items.filter((row) => row.status === "add").map((row) => row.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(addable));
  const [refusal, setRefusal] = useState<string | null>(null);
  const ticked = items.filter((row) => selected.has(row.id)).map((row) => row.id);
  const toAdd = ticked.filter((id) => addable.includes(id));
  const onDone = (state: XeroActionResult) => setRefusal(state.ok ? null : state.message);
  if (items.length === 0 && closed.length === 0) return null;

  return (
    <section aria-labelledby="from-xero-title" id="from-xero" className="mb-8">
      <SectionHeader
        id="from-xero-title"
        title={items.length === 1 ? "From Xero: 1 bill to add" : `From Xero: ${items.length} bills to add`}
        meta={organisation ? `${organisation} · nothing is added until you add it` : "Nothing is added until you add it"}
      />
      <Card className="space-y-4 p-5">
        {items.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((row) => (
              <li key={row.id} className="space-y-1.5 px-4 py-3">
                <div className="min-w-0">
                  {canAdd ? (
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                      label={
                        <span className="font-semibold text-ink">
                          {row.supplier}
                          {row.number ? ` · ${row.number}` : ""}
                        </span>
                      }
                      description={`${AMOUNT.format(Number(row.amount))} ${row.currency} · due ${day(row.dueOn)}`}
                    />
                  ) : (
                    <div className="text-sm">
                      <p className="font-semibold text-ink">
                        {row.supplier}
                        {row.number ? ` · ${row.number}` : ""}
                      </p>
                      <p className="text-xs text-ink-3">
                        {AMOUNT.format(Number(row.amount))} {row.currency} · due {day(row.dueOn)}
                      </p>
                    </div>
                  )}
                </div>
                {/* Under the bill, level with its label: what will happen to it. */}
                <div className={canAdd ? "flex flex-wrap items-center gap-2 pl-8" : "flex flex-wrap items-center gap-2"}>
                  {row.supplierNew && row.status === "add" && (
                    <Badge size="sm" tone="agent">
                      New counterparty
                    </Badge>
                  )}
                  <Fate row={row} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {canAdd && items.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Act action={addXeroBillsAction} orgSlug={orgSlug} connectionId={connectionId} ids={toAdd} goodsReceived label="Add, goods received" pendingLabel="Adding…" icon={<FilePlus2 aria-hidden />} onDone={onDone} />
              <Act action={addXeroBillsAction} orgSlug={orgSlug} connectionId={connectionId} ids={toAdd} goodsReceived={false} label="Add, not received yet" pendingLabel="Adding…" variant="secondary" onDone={onDone} />
              <Act action={dismissXeroBillsAction} orgSlug={orgSlug} connectionId={connectionId} ids={ticked} label="Dismiss" pendingLabel="Dismissing…" icon={<X aria-hidden />} variant="secondary" onDone={onDone} />
            </div>
            <p className="max-w-prose text-xs leading-5 text-ink-3">
              A new counterparty is added as a vendor with no payment address yet and a payment limit of its largest bill here; it needs a purchase order on
              file unless you change that on Counterparties. Xero approving a bill does not approve its payment: the agent decides it.
            </p>
            <FormMessage tone={refusal ? "error" : "neutral"}>{refusal}</FormMessage>
          </div>
        ) : items.length > 0 ? (
          <p className="text-sm text-ink-3">An owner or admin adds bills from Xero.</p>
        ) : null}
        {closed.length > 0 && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Closed in Xero after they were added</p>
            <ul className="space-y-1 text-sm text-held">
              {closed.map((row) => (
                <li key={row.id}>
                  {row.supplier}
                  {row.number ? ` · ${row.number}` : ""}: {CLOSED_WORDS[row.sourceStatus] ?? row.sourceStatus}. Look at it in Payables before the agent pays it.
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}
