import { runCycleSoon } from "../agent/cycle-soon";
import { verifyBlindpaySignature } from "../blindpay/webhook";
import { BANK_ID } from "../circle/bank-payout";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";

/**
 * BlindPay's notices (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B8, B9): the Svix signature checked
 * before the body is read for anything; then a payout's notice starts a cycle in the workspace whose payment waits on
 * that payout, which reads the payout from BlindPay itself. What a notice says is never used as it is. Every other
 * notice is acknowledged and starts nothing.
 */

export interface BlindpayNoticeDeps {
  secret: string | null;
  now?: () => number;
  candidates?: () => Promise<Array<{ id: string; slug: string; mode: "sandbox" | "live" }>>;
  inFlight?: (orgId: string, providerTxId: string) => Promise<boolean>;
  raise?: typeof runCycleSoon;
}

// An intent still waiting on its transfer, as the transfer watch reads them (Circle notifications N3).
const WAITING = ["submitting", "pending", "failed"];

async function candidates(): Promise<Array<{ id: string; slug: string; mode: "sandbox" | "live" }>> {
  return unwrap(await platformDb().from("orgs").select("id, slug, mode").order("slug")) as Array<{ id: string; slug: string; mode: "sandbox" | "live" }>;
}

async function inFlight(orgId: string, providerTxId: string): Promise<boolean> {
  return withOrg(orgId, async () => {
    const rows = unwrap(await db().from("payment_intents").select("id").eq("provider_tx_id", providerTxId).in("status", WAITING).limit(1)) as unknown[];
    return rows.length > 0;
  });
}

export async function handleBlindpayNotice(raw: string, headers: { get(name: string): string | null }, deps: BlindpayNoticeDeps): Promise<{ status: number; started?: string }> {
  if (!deps.secret) return { status: 401 };
  const signed = verifyBlindpaySignature(headers, raw, deps.secret, (deps.now ?? Date.now)());
  if (!signed.ok) return { status: 401 };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400 };
  }
  const notice = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const event = typeof notice.webhook_event === "string" ? notice.webhook_event : null;
  const payoutId = typeof notice.id === "string" && /^po_[A-Za-z0-9_]{4,64}$/.test(notice.id) ? notice.id : null;
  if (!event?.startsWith("payout.") || !payoutId) return { status: 200 };
  const providerTxId = `${BANK_ID}${payoutId}`;
  let unread = 0;
  for (const org of await (deps.candidates ?? candidates)()) {
    try {
      if (!(await (deps.inFlight ?? inFlight)(org.id, providerTxId))) continue;
    } catch (error) {
      unread += 1;
      console.error("BlindPay notice: workspace not read", org.slug, error instanceof Error ? error.message : String(error));
      continue;
    }
    (deps.raise ?? runCycleSoon)({ orgId: org.id, sandbox: org.mode === "sandbox", kind: "payment_settled" });
    return { status: 200, started: org.slug };
  }
  // A workspace that could not be read may be the one: BlindPay sends the notice again.
  return { status: unread > 0 ? 503 : 200 };
}
