import { z } from "zod";
import { db, platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { ledgerPublicKeyPems } from "../ledger";
import { teamJourneyView, type TeamJourney, type TeamJourneys } from "../team-journey";

const row = z.object({ orgId: z.string().uuid() }).passthrough();
const document = z.object({ direct: row.nullable(), base: row.nullable() });
const MEMO_MS = 60_000;
let memo: { at: number; value: Promise<TeamJourneys> } | null = null;

async function fetchJourneys(): Promise<TeamJourneys> {
  const result = await platformDb().rpc("landing_team_journeys");
  // Until the additive migration is released, an existing service-role function can select one eligible team scope.
  // This may find fewer bills than the platform RPC; it never widens eligibility or invents a historical fixture.
  if (result.error && ["PGRST202", "42883"].includes(result.error.code ?? "")) return readSelectedTeamScope();
  if (result.error) throw new Error("Team journey read unavailable");
  const found = document.parse(result.data);
  async function shown(value: z.infer<typeof row> | null): Promise<TeamJourney | null> {
    if (!value || !teamJourneyView(value, {})) return null;
    const publicKeys = await withOrg(value.orgId, async () => ledgerPublicKeyPems());
    return teamJourneyView(value, publicKeys);
  }
  const [direct, base] = await Promise.all([shown(found.direct), shown(found.base)]);
  return { direct, base };
}

interface ScopedIntent {
  source_id: string; amount: number | string; token: string; chain: string | null; network: string;
  status: string; provider: string; provider_mode: string; destination_chain: string | null;
  tx_hash: string | null; mint_tx_hash: string | null; confirmed_at: string | null;
  bridge_fee: number | string | null; payout_route: string | null;
}
interface ScopedEntry {
  seq: number; ts: string; actor: string; action: string; detail: Record<string, unknown>;
  body_hash: string; signature: string; prev_hash: string; hash: string; signing_key_id: string | null;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const AP_ACTIONS = new Set(["ap_pay", "ap_schedule", "ap_hold", "ap_request_info", "ap_flag_fraud"]);
const EVENT_COLUMNS = "seq,ts,actor,action,detail,body_hash,signature,prev_hash,hash,signing_key_id";

/** No argument can select a workspace: only the existing team-only RPC's private identity enters this scope. */
async function readSelectedTeamScope(): Promise<TeamJourneys> {
  const empty: TeamJourneys = { direct: null, base: null };
  const selected = await platformDb().rpc("latest_team_decision");
  if (selected.error) throw new Error("Team selector unavailable");
  if (selected.data === null) return empty;
  const identity = z.object({ orgId: z.string().uuid(), network: z.string() }).parse(selected.data);
  if (identity.network !== "arc-mainnet") return empty;
  const organization = await platformDb().from("orgs").select("mode,network").eq("id", identity.orgId).maybeSingle();
  if (organization.error) throw new Error("Team scope unavailable");
  if (organization.data?.mode !== "live" || organization.data.network !== "arc-mainnet") return empty;
  return withOrg(identity.orgId, async () => {
    const found = await db().from("payment_intents")
      .select("source_id,amount,token,chain,network,status,provider,provider_mode,destination_chain,tx_hash,mint_tx_hash,confirmed_at,bridge_fee,payout_route")
      .eq("source_type", "invoice").eq("status", "confirmed").eq("provider", "circle").eq("provider_mode", "live").eq("network", "arc-mainnet")
      .order("confirmed_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(1000);
    if (found.error) throw new Error("Team payments unavailable");
    const publicKeys = ledgerPublicKeyPems();
    for (const intent of (found.data ?? []) as unknown as ScopedIntent[]) {
      const base = intent.destination_chain === "BASE";
      if (empty[base ? "base" : "direct"] || intent.chain !== "ARC" || intent.network !== "arc-mainnet" || intent.status !== "confirmed"
          || intent.provider !== "circle" || intent.provider_mode !== "live" || intent.payout_route === "gateway"
          || (intent.destination_chain !== null && intent.destination_chain !== "ARC" && !base)) continue;
      const invoice = await db().from("invoices").select("direction,status,counterparties!invoices_counterparty_id_org_fkey(sample)").eq("id", intent.source_id).maybeSingle();
      if (invoice.error) throw new Error("Team bill unavailable");
      if (!z.object({ direction: z.literal("payable"), status: z.literal("paid"), counterparties: z.object({ sample: z.literal(false) }) }).safeParse(invoice.data).success) continue;
      const entries = await db().from("ledger_entries").select(EVENT_COLUMNS).eq("detail->>invoiceId", intent.source_id).order("seq", { ascending: false }).limit(1000);
      if (entries.error) throw new Error("Team entries unavailable");
      const ordered = ((entries.data ?? []) as unknown as ScopedEntry[]).filter(entry => entry.detail.invoiceId === intent.source_id).sort((a, b) => b.seq - a.seq);
      const refs = (entry: ScopedEntry) => [entry.detail.txRef, object(entry.detail.execution).txRef, object(entry.detail.execution).mintTxHash]
        .filter((value): value is string => typeof value === "string").map(value => value.toLowerCase());
      const records = ordered.filter(entry => ["ap_pay", "approval_paid", "ap_reconcile"].includes(entry.action)
        && refs(entry).some(ref => ref === intent.tx_hash?.toLowerCase() || (base && ref === intent.mint_tx_hash?.toLowerCase())));
      const record = (base && intent.mint_tx_hash ? records.find(entry => refs(entry).includes(intent.mint_tx_hash!.toLowerCase())) : null) ?? records[0];
      const firstRecord = records.length ? Math.min(...records.map(entry => entry.seq)) : null;
      // Later decisions about the same bill must not become checks/approval for this already-recorded transfer.
      const history = ordered.filter(entry => firstRecord !== null ? entry.seq <= firstRecord : Boolean(intent.confirmed_at && Date.parse(entry.ts) <= Date.parse(intent.confirmed_at)));
      const check = history.find(entry => entry.actor === "agent" && AP_ACTIONS.has(entry.action));
      const hold = history.find(entry => entry.actor === "agent" && AP_ACTIONS.has(entry.action)
        && (entry.action === "ap_hold" || entry.detail.guardrailBlocked === true || Boolean(object(entry.detail.execution).heldBecause ?? entry.detail.heldBecause)));
      const observed = object(check?.detail.observed);
      const event = (entry: ScopedEntry | undefined | null) => entry ? { seq: entry.seq, recordedAt: entry.ts, action: entry.action,
        link: { body_hash: entry.body_hash, signature: entry.signature, prev_hash: entry.prev_hash, hash: entry.hash, signing_key_id: entry.signing_key_id } } : null;
      const boolean = (value: unknown) => typeof value === "boolean" ? value : null;
      const facts = {
        amount: intent.amount, currency: intent.token, network: intent.network, status: "paid",
        received: event(ordered.find(entry => entry.action === "create_invoice")), check: event(check), hold: event(hold),
        approval: event(history.find(entry => entry.actor === "human" && ["approval_given", "approval_paid"].includes(entry.action))),
        record: event(record),
        observed: { hasPurchaseOrder: typeof observed.poReference === "string" ? observed.poReference.trim().length > 0 : null,
          goodsReceived: boolean(observed.goodsReceived), purchaseOrderRequired: boolean(observed.purchaseOrderRequired), riskLevel: observed.riskLevel },
        rule: hold?.detail.guardrailRule,
        payment: { route: base ? "cctp" : "direct", confirmationRecordedAt: intent.confirmed_at, txHash: intent.tx_hash,
          mintTxHash: base ? intent.mint_tx_hash : null, destinationChain: base ? "BASE" : "ARC", feeUsdc: base ? intent.bridge_fee : null },
      };
      empty[base ? "base" : "direct"] = teamJourneyView(facts, publicKeys);
      if (empty.direct && empty.base) break;
    }
    return empty;
  });
}

/** One minute per instance. An unavailable migration/read returns null; an empty successful read has two null slots. */
export async function readTeamJourneys(now = Date.now()): Promise<TeamJourneys | null> {
  if (!memo || now - memo.at > MEMO_MS) {
    const value = fetchJourneys(); memo = { at: now, value };
    value.catch(() => { if (memo?.value === value) memo = null; });
  }
  try { return await memo.value; }
  catch { console.error("landing: team journeys unavailable"); return null; }
}
