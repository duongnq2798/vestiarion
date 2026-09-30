import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { paymentLimitForRisk } from "./compliance";
import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { usdcAmountSchema } from "./intake-validation";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * Changing a counterparty's configured payment limit. Every export that
 * touches the database runs inside an organization scope.
 *
 * The configured limit (`baseline_payment_limit`) is what the business sets;
 * the current limit (`payment_limit`) is what screening derives from it for
 * the counterparty's risk (`paymentLimitForRisk`: the whole of it when clear,
 * a quarter when medium, 0 when high). An edit writes both in one update, from
 * the risk screening already found, so there is never a moment when the agent
 * reads a current limit that no longer follows from the configured one.
 *
 * In the guardrail an empty limit means no limit, so a vendor's or a
 * contractor's can be changed but never cleared; a client's may be, as when
 * it was added. The write is a compare-and-set on the configured limit it
 * read, like the address edit.
 *
 * It is refused while a cycle is running: the cycle's compliance sweep
 * rewrites both limits from the row it read when it started, so an edit that
 * landed in the middle would be silently undone.
 */

export type CounterpartyLimitErrorCode = "invalid" | "required" | "unchanged" | "conflict" | "not_found" | "cycle_running";

const MESSAGES: Record<Exclude<CounterpartyLimitErrorCode, "invalid">, string> = {
  required: "A vendor or contractor needs a payment limit: without one, the agent could pay any amount.",
  unchanged: "That is already this counterparty's limit.",
  conflict: "Someone else changed this limit a moment ago.",
  not_found: "Counterparty not found.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
};

export class CounterpartyLimitError extends Error {
  constructor(
    readonly code: CounterpartyLimitErrorCode,
    message: string = MESSAGES[code as Exclude<CounterpartyLimitErrorCode, "invalid">]
  ) {
    super(message);
    this.name = "CounterpartyLimitError";
  }
}

/** A form's limit field for a counterparty of `role`: a USDC amount, or `null` to clear a client's. */
export function parseLimitInput(raw: string, role: string): { ok: true; limit: string | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return role === "client" ? { ok: true, limit: null } : { ok: false, message: MESSAGES.required };
  const parsed = usdcAmountSchema.safeParse(trimmed);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid payment limit" };
  return { ok: true, limit: parsed.data };
}

const toNum = (value: unknown): number | null => (value == null || value === "" ? null : Number(value));

export async function changeCounterpartyLimit(input: {
  actorId: string;
  counterpartyId: string;
  raw: string;
}): Promise<{ name: string; from: number | null; to: number | null; current: number | null }> {
  const result = await db()
    .from("counterparties")
    .select("id, name, role, risk_level, baseline_payment_limit, payment_limit")
    .eq("id", input.counterpartyId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { id: string; name: string; role: string; risk_level: string; baseline_payment_limit: string | number | null } | null;
  if (!row) throw new CounterpartyLimitError("not_found");

  const parsed = parseLimitInput(input.raw, row.role);
  if (!parsed.ok) throw new CounterpartyLimitError(parsed.message === MESSAGES.required ? "required" : "invalid", parsed.message);

  const from = toNum(row.baseline_payment_limit);
  const to = toNum(parsed.limit);
  if (from === to) throw new CounterpartyLimitError("unchanged");
  const current = paymentLimitForRisk(row.risk_level, to);

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new CounterpartyLimitError("cycle_running");

  const update = db()
    .from("counterparties")
    .update({ baseline_payment_limit: parsed.limit, payment_limit: current })
    .eq("id", row.id);
  const guarded = row.baseline_payment_limit == null ? update.is("baseline_payment_limit", null) : update.eq("baseline_payment_limit", row.baseline_payment_limit);
  const rows = unwrap(await guarded.select("id")) as Array<{ id: string }>;
  if (rows.length === 0) throw new CounterpartyLimitError("conflict");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "compliance",
    action: "counterparty_limit_changed",
    summary: `Changed ${row.name}'s payment limit from ${from ?? "none"} to ${to ?? "none"} USDC`,
    detail: { by: input.actorId, counterpartyId: row.id, from, to, currentLimit: current },
  });

  return { name: row.name, from, to, current };
}
