import { db, unwrap } from "./dal";
import { appendLedgerEntry } from "./ledger";
import { cadenceLabel, dueOn, type RecurringForm, type RecurringUnit } from "./recurring";

/**
 * Setting recurring payments up and stopping them
 * (docs/superpowers/specs/2026-10-02-recurring-payables-design.md §2, R5). Runs inside the
 * workspace's scope; who may (`records.write`) is the action's check. Each change is signed by the
 * person who made it.
 */

export type RecurringPayableErrorCode = "counterparty_not_found" | "client" | "not_found" | "not_active";

const MESSAGES: Record<RecurringPayableErrorCode, string> = {
  counterparty_not_found: "Counterparty not found.",
  client: "A client is paid by you, not the other way round: choose a vendor or a contractor.",
  not_found: "That recurring payment was not found.",
  not_active: "That recurring payment has already stopped.",
};

export class RecurringPayableError extends Error {
  constructor(readonly code: RecurringPayableErrorCode) {
    super(MESSAGES[code]);
    this.name = "RecurringPayableError";
  }
}

export interface RecurringPayableView {
  id: string;
  counterpartyName: string;
  amount: number;
  currency: "USDC" | "EURC";
  memo: string;
  cadence: string;
  /** The next period's due date, `YYYY-MM-DD`; null once it no longer runs. */
  nextDueOn: string | null;
  endsOn: string | null;
  status: "active" | "stopped" | "ended";
}

interface Row {
  id: string;
  amount: string;
  currency: "USDC" | "EURC";
  memo: string;
  every_count: number;
  every_unit: RecurringUnit;
  starts_on: string;
  ends_on: string | null;
  next_period: number;
  status: "active" | "stopped" | "ended";
  counterparties: { name: string } | null;
}

/** The workspace's recurring payments, the running ones first, each with its next due date. */
export async function listRecurringPayables(): Promise<RecurringPayableView[]> {
  const rows = unwrap(
    await db()
      .from("recurring_payables")
      .select("id, amount, currency, memo, every_count, every_unit, starts_on, ends_on, next_period, status, counterparties(name)")
      .order("created_at", { ascending: false })
  ) as unknown as Row[];
  const views = rows.map((row): RecurringPayableView => {
    const next = row.status === "active" ? dueOn({ startsOn: row.starts_on, everyCount: row.every_count, everyUnit: row.every_unit }, row.next_period) : null;
    return {
      id: row.id,
      counterpartyName: row.counterparties?.name ?? "Unknown counterparty",
      amount: Number(row.amount),
      currency: row.currency,
      memo: row.memo,
      cadence: cadenceLabel(row.every_count, row.every_unit),
      nextDueOn: next && (!row.ends_on || next <= row.ends_on) ? next : null,
      endsOn: row.ends_on,
      status: row.status,
    };
  });
  return [...views.filter((view) => view.status === "active"), ...views.filter((view) => view.status !== "active")];
}

export async function createRecurringPayable(input: { actorId: string; form: RecurringForm }): Promise<{ id: string; counterpartyName: string; cadence: string }> {
  const { form } = input;
  const lookup = await db().from("counterparties").select("id, name, role").eq("id", form.counterpartyId).maybeSingle<{ id: string; name: string; role: string }>();
  if (lookup.error) throw new Error(lookup.error.message);
  const counterparty = lookup.data;
  if (!counterparty) throw new RecurringPayableError("counterparty_not_found");
  if (counterparty.role === "client") throw new RecurringPayableError("client");

  const created = unwrap(
    await db()
      .from("recurring_payables")
      .insert({
        counterparty_id: counterparty.id,
        amount: form.amount,
        currency: form.currency,
        memo: form.memo,
        po_reference: form.poReference,
        goods_received: form.goodsReceived,
        every_count: form.everyCount,
        every_unit: form.everyUnit,
        starts_on: form.startsOn,
        ends_on: form.endsOn,
        created_by: input.actorId,
      })
      .select("id")
      .single<{ id: string }>()
  );
  const cadence = cadenceLabel(form.everyCount, form.everyUnit);
  await appendLedgerEntry({
    actor: "human",
    domain: "ap",
    action: "recurring_payable_created",
    summary: `Set up a recurring payment to ${counterparty.name}: ${form.amount} ${form.currency} ${cadence} from ${form.startsOn}`,
    detail: {
      by: input.actorId,
      recurringId: created.id,
      counterpartyId: counterparty.id,
      amount: Number(form.amount),
      currency: form.currency,
      memo: form.memo,
      poReference: form.poReference,
      goodsReceived: form.goodsReceived,
      everyCount: form.everyCount,
      everyUnit: form.everyUnit,
      startsOn: form.startsOn,
      endsOn: form.endsOn,
    },
  });
  return { id: created.id, counterpartyName: counterparty.name, cadence };
}

/** Stops a running schedule. What it already created stays, and is decided as before. */
export async function stopRecurringPayable(input: { actorId: string; id: string }): Promise<{ counterpartyName: string }> {
  const found = await db().from("recurring_payables").select("id, status, counterparties(name)").eq("id", input.id).maybeSingle<{ id: string; status: string; counterparties: { name: string } | null }>();
  if (found.error) throw new Error(found.error.message);
  if (!found.data) throw new RecurringPayableError("not_found");
  const stopped = unwrap(
    await db()
      .from("recurring_payables")
      .update({ status: "stopped", stopped_at: new Date().toISOString(), stopped_by: input.actorId })
      .eq("id", input.id)
      .eq("status", "active")
      .select("id")
  ) as Array<{ id: string }>;
  if (stopped.length === 0) throw new RecurringPayableError("not_active");
  const name = found.data.counterparties?.name ?? "a counterparty";
  await appendLedgerEntry({
    actor: "human",
    domain: "ap",
    action: "recurring_payable_stopped",
    summary: `Stopped the recurring payment to ${name}`,
    detail: { by: input.actorId, recurringId: input.id },
  });
  return { counterpartyName: name };
}
