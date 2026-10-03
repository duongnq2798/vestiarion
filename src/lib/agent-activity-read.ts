import { db, unwrap } from "./dal";
import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { ACTIVITY_ACTIONS, activityItems, TRIGGER_ACTIONS, type ActivityEntry, type ActivityItem, type ActivityRefs } from "./agent-activity";

/** What the agent is doing in the workspace in scope, and what it decided after `since` (agent activity). */
export interface AgentActivity {
  /** A cycle running now: one still `running` that started within the in-progress window. */
  running: { startedAt: string } | null;
  /** The ledger's newest entry: where a page that has just opened starts telling. */
  head: number;
  /** When the last cycle completed, as the shell says it. */
  lastCycleAt: string | null;
  /** The agent's decisions after `since`, oldest first, in words; none when `since` is not given. */
  items: ActivityItem[];
  /**
   * The last ledger entry this read has covered: the head, or the last entry read when a full page came back and more
   * may follow. A reader that keeps a cursor (the Telegram stage) moves it here, past entries that say nothing.
   */
  through: number;
}

/** At most this many entries are read per call: more than a page tells one by one. */
const READ_AT_MOST = 20;

const strings = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string"))];

/**
 * Reads the agent's activity for a page that is open, as cheaply as it can be asked every few seconds: the running
 * cycle, the ledger head and the last cycle's time, then — only when something is new — the new decisions and what
 * they are about. Runs inside the workspace's scope.
 */
export async function readAgentActivity(since: number | null, now: number = Date.now()): Promise<AgentActivity> {
  const client = db();
  const [runs, heads, lastCycle] = await Promise.all([
    client
      .from("cycle_runs")
      .select("started_at")
      .eq("status", "running")
      .gt("started_at", new Date(now - CYCLE_IN_PROGRESS_MS).toISOString())
      .order("started_at", { ascending: false })
      .limit(1),
    client.from("ledger_entries").select("seq").order("seq", { ascending: false }).limit(1),
    client.from("ledger_entries").select("ts").eq("action", "cycle_complete").order("seq", { ascending: false }).limit(1),
  ]);
  const started = (unwrap(runs) as Array<{ started_at: string }>)[0]?.started_at ?? null;
  const head = (unwrap(heads) as Array<{ seq: number }>)[0]?.seq ?? 0;
  const lastCycleAt = (unwrap(lastCycle) as Array<{ ts: string }>)[0]?.ts ?? null;
  const base = { running: started ? { startedAt: started } : null, head, lastCycleAt };
  if (since === null || since >= head) return { ...base, items: [], through: Math.max(head, since ?? 0) };

  const entries = unwrap(
    await client
      .from("ledger_entries")
      .select("seq, ts, action, detail")
      .eq("actor", "agent")
      .in("action", ACTIVITY_ACTIONS)
      .gt("seq", since)
      .order("seq", { ascending: true })
      .limit(READ_AT_MOST)
  ) as ActivityEntry[];
  // Fewer than a page came back: every entry up to the head was read. A full page may have more after its last entry.
  const through = entries.length < READ_AT_MOST ? Math.max(head, entries.at(-1)?.seq ?? head) : (entries.at(-1)?.seq ?? head);
  if (entries.length === 0) return { ...base, items: [], through };

  const invoiceIds = strings(entries.map((entry) => entry.detail.invoiceId));
  const milestoneIds = strings(entries.map((entry) => entry.detail.milestoneId));
  const [invoiceRows, milestoneRows, triggerRows] = await Promise.all([
    invoiceIds.length > 0
      ? client.from("invoices").select("id, amount, currency, status, tx_ref, scheduled_for, counterparties(name)").in("id", invoiceIds)
      : Promise.resolve({ data: [], error: null }),
    milestoneIds.length > 0
      ? client.from("milestones").select("id, title, amount, tx_ref, counterparties(name)").in("id", milestoneIds)
      : Promise.resolve({ data: [], error: null }),
    // The people's actions that gave the agent each decision: how long after them it decided (decision trail R4).
    invoiceIds.length > 0
      ? client
          .from("ledger_entries")
          .select("seq, ts, action, detail->>invoiceId")
          .eq("actor", "human")
          .in("action", TRIGGER_ACTIONS)
          .in("detail->>invoiceId", invoiceIds)
          .order("seq", { ascending: false })
          .limit(READ_AT_MOST * 3)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const triggers = new Map<string, Array<{ seq: number; ts: string; action: string }>>();
  for (const row of unwrap(triggerRows) as unknown as Array<{ seq: number; ts: string; action: string; invoiceId: string | null }>) {
    if (!row.invoiceId) continue;
    triggers.set(row.invoiceId, [...(triggers.get(row.invoiceId) ?? []), { seq: row.seq, ts: row.ts, action: row.action }]);
  }
  const refs: ActivityRefs = {
    invoices: new Map(
      (unwrap(invoiceRows) as unknown as Array<{
        id: string;
        amount: string | number;
        currency: string | null;
        status: string;
        tx_ref: string | null;
        scheduled_for: string | null;
        counterparties: { name: string } | null;
      }>).map((row) => [
        row.id,
        {
          name: row.counterparties?.name ?? "a counterparty",
          amount: Number(row.amount),
          currency: row.currency === "EURC" ? "EURC" : "USDC",
          status: row.status,
          txRef: row.tx_ref,
          scheduledFor: row.scheduled_for,
        },
      ])
    ),
    milestones: new Map(
      (unwrap(milestoneRows) as unknown as Array<{ id: string; title: string; amount: string | number; tx_ref: string | null; counterparties: { name: string } | null }>).map(
        (row) => [row.id, { name: row.counterparties?.name ?? "a contractor", title: row.title, amount: Number(row.amount), txRef: row.tx_ref }]
      )
    ),
    triggers,
  };
  return { ...base, items: activityItems(entries, refs), through };
}
