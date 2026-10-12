"use client";

import { FilePlus2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { addAccountingBillsAction, dismissAccountingBillsAction, type AccountingActionResult } from "@/app/actions/accounting";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { PROVIDER_LABELS, PROVIDER_WORDS, type ProviderId } from "@/lib/connectors/provider";
import type { ClosedRowView, PartlyPaidRowView, ReviewRowView } from "@/lib/connectors/review";

const INITIAL: AccountingActionResult = { ok: false, message: "" };
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 28", a bill's due day. */
function day(iso: string | null): string {
  if (!iso) return "no due date";
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

const money = (amount: string) => AMOUNT.format(Number(amount));

/** Select all's state: every bill that can be added is ticked, some are, or none (Bills & receivables tabs B12). */
export function reviewSelection(selected: ReadonlySet<string>, addable: readonly string[]): boolean | "indeterminate" {
  const ticked = addable.filter((id) => selected.has(id)).length;
  if (ticked === 0) return false;
  return ticked === addable.length ? true : "indeterminate";
}

/** Whether the tool says part of the bill was paid already: it is offered at what is left (Q9). */
const partlyPaid = (row: ReviewRowView) => row.total !== undefined && Number(row.total) > Number(row.amount);

function Fate({ row }: { row: ReviewRowView }) {
  if (row.status === "add") {
    return (
      <span className="text-sm text-ink-2">
        Ready to add{row.usdc ? `, at ${money(row.usdc)} USDC` : ""}
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
  action: typeof addAccountingBillsAction;
  orgSlug: string;
  connectionId: string;
  ids: string[];
  goodsReceived?: boolean;
  label: string;
  pendingLabel: string;
  icon?: ReactNode;
  variant?: "secondary";
  onDone: (state: AccountingActionResult) => void;
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
 * The bills an accounting tool brought in, waiting for a person (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X11, X19; docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q9, Q19), one list per tool: each with its
 * supplier, number, amount (what is left to pay, for a bill partly paid in the tool), due day and fate under the bill
 * list's own check. Nothing becomes a payable until someone who adds records ticks it and adds it, saying whether its
 * goods or services were received; a bill can be dismissed instead. Every bill starts unticked, with Select all beside the
 * list (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B12): one click never adds the whole list. Below, the bills already added that the tool since
 * says were paid, voided or deleted, or partly paid.
 */
export function AccountingBillsReview({
  provider,
  orgSlug,
  connectionId,
  organisation,
  items,
  closed,
  partlyPaidSince = [],
  canAdd,
}: {
  provider: ProviderId;
  orgSlug: string;
  connectionId: string;
  organisation: string | null;
  items: ReviewRowView[];
  closed: ClosedRowView[];
  partlyPaidSince?: PartlyPaidRowView[];
  canAdd: boolean;
}) {
  const label = PROVIDER_LABELS[provider];
  const addable = items.filter((row) => row.status === "add").map((row) => row.id);
  // Unticked to start: a person chooses each bill, or all of them with Select all.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  const ticked = items.filter((row) => selected.has(row.id)).map((row) => row.id);
  const toAdd = ticked.filter((id) => addable.includes(id));
  const onDone = (state: AccountingActionResult) => setRefusal(state.ok ? null : state.message);
  if (items.length === 0 && closed.length === 0 && partlyPaidSince.length === 0) return null;
  const closedWords: Record<string, string> = { paid: `paid in ${label}`, voided: `voided in ${label}`, deleted: `deleted in ${label}` };
  const amountLine = (row: ReviewRowView) =>
    partlyPaid(row) ? `${money(row.amount)} ${row.currency} left of ${money(row.total as string)} · due ${day(row.dueOn)}` : `${money(row.amount)} ${row.currency} · due ${day(row.dueOn)}`;

  return (
    <section aria-labelledby={`from-${provider}-title`} id={`from-${provider}`} className="mb-8">
      <SectionHeader
        id={`from-${provider}-title`}
        title={items.length === 1 ? `From ${label}: 1 bill to add` : `From ${label}: ${items.length} bills to add`}
        meta={organisation ? `${organisation} · nothing is added until you add it` : "Nothing is added until you add it"}
      />
      <Card className="space-y-4 p-5">
        {canAdd && addable.length > 0 && (
          <Checkbox
            checked={reviewSelection(selected, addable)}
            onCheckedChange={(checked) => setSelected(checked === true ? new Set(addable) : new Set())}
            label={<span className="font-medium text-ink">Select all</span>}
            description={addable.length === 1 ? "The 1 bill ready to add" : `The ${addable.length} bills ready to add`}
          />
        )}
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
                      description={amountLine(row)}
                    />
                  ) : (
                    <div className="text-sm">
                      <p className="font-semibold text-ink">
                        {row.supplier}
                        {row.number ? ` · ${row.number}` : ""}
                      </p>
                      <p className="text-xs text-ink-3">{amountLine(row)}</p>
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
                  {partlyPaid(row) && (
                    <Badge size="sm" tone="held">
                      Partly paid in {label}
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
              <Act action={addAccountingBillsAction} orgSlug={orgSlug} connectionId={connectionId} ids={toAdd} goodsReceived label="Add, goods received" pendingLabel="Adding…" icon={<FilePlus2 aria-hidden />} onDone={onDone} />
              <Act action={addAccountingBillsAction} orgSlug={orgSlug} connectionId={connectionId} ids={toAdd} goodsReceived={false} label="Add, not received yet" pendingLabel="Adding…" variant="secondary" onDone={onDone} />
              <Act action={dismissAccountingBillsAction} orgSlug={orgSlug} connectionId={connectionId} ids={ticked} label="Dismiss" pendingLabel="Dismissing…" icon={<X aria-hidden />} variant="secondary" onDone={onDone} />
            </div>
            <p className="max-w-prose text-xs leading-5 text-ink-3">
              A new counterparty is added as a vendor with no payment address yet and a payment limit of its largest bill here; it needs a purchase order on
              file unless you change that on Counterparties. {PROVIDER_WORDS[provider].approval}
            </p>
            <FormMessage tone={refusal ? "error" : "neutral"}>{refusal}</FormMessage>
          </div>
        ) : items.length > 0 ? (
          <p className="text-sm text-ink-3">An owner or admin adds bills from {label}.</p>
        ) : null}
        {closed.length > 0 && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Closed in {label} after they were added</p>
            <ul className="space-y-1 text-sm text-held">
              {closed.map((row) => (
                <li key={row.id}>
                  {row.supplier}
                  {row.number ? ` · ${row.number}` : ""}: {closedWords[row.sourceStatus] ?? row.sourceStatus}. Look at it in Bills before the agent pays it.
                </li>
              ))}
            </ul>
          </div>
        )}
        {partlyPaidSince.length > 0 && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Partly paid in {label} after they were added</p>
            <ul className="space-y-1 text-sm text-held">
              {partlyPaidSince.map((row) => (
                <li key={row.id}>
                  {row.supplier}
                  {row.number ? ` · ${row.number}` : ""}: {money(row.left)} {row.currency} left of the {money(row.added)} added. Look at it in Bills before the agent pays
                  it.
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}
