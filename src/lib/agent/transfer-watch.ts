import { siteOrigin } from "../auth/env";
import { getChainProvider } from "../circle";
import type { ChainProvider } from "../circle/types";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { paymentStuckEmail } from "../email/payment-stuck";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { NETWORK_IDS, networkOf, networkProfile } from "../network";
import { DIGEST_MAX_RECIPIENTS, decidingRecipients } from "../notifications/waiting";
import { txUrl } from "../payee-chains";

/**
 * The transfer watch (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md): every 5 minutes it finds the
 * live payments whose current attempt was sent longer ago than their network's `stuckAfterMinutes`, asks Circle again,
 * read-only, and signs a `payment_stuck` entry for each still unconfirmed, once per attempt (D5). The console, Slack,
 * Telegram and webhooks carry that entry as they carry the agent's decisions (D6).
 *
 * It reads and tells: it never sends, retries, settles or holds anything, and it writes no payment, invoice or milestone.
 * The cycle keeps doing that. It runs whatever the switches say (D4): a payment already sent can be stuck while payments
 * are off, the agent is paused or Arc mainnet is switched off, and that is when a person most needs to know.
 */

/** The shortest wait of any network: the watch reads what was sent before it, then holds each to its own network's. */
const SHORTEST_MINUTES = Math.min(...NETWORK_IDS.map((id) => networkProfile(id).stuckAfterMinutes));
const MINUTE_MS = 60_000;

export interface TransferWatchResult {
  slug: string;
  /** Live payments in flight past the shortest wait, as read for this workspace. */
  inFlight: number;
  /** How many of them were told this run. */
  told: number;
  error?: string;
}

interface WatchDeps {
  now?: () => number;
  /** The workspace's chain provider; `getChainProvider` unless a test passes its own. A throw means Circle cannot be asked. */
  provider?: () => ChainProvider;
  /** How the deciding members are emailed (D6); the platform's email settings, Resend and the digest's recipients by default. */
  mail?: {
    settings?: { apiKey: string; from: string } | null;
    send?: (message: EmailMessage, settings: { apiKey: string; from: string }) => Promise<SendResult>;
    recipients?: (orgId: string) => Promise<Array<{ email: string }>>;
  };
}

/** One payment told this run, as its email words it. */
interface Told {
  detail: StuckDetail;
  payeeName: string;
}

interface InFlight {
  source_type: "invoice" | "milestone";
  source_id: string;
  idempotency_key: string;
  provider_tx_id: string | null;
  tx_hash: string | null;
  amount: string | number;
  token: string | null;
  status: string;
  transfer_attempt: number | null;
  submitted_at: string;
  network: string | null;
}

/** What one stuck payment's entry records (D5). */
export interface StuckDetail {
  invoiceId?: string;
  milestoneId?: string;
  counterpartyId: string | null;
  amount: number;
  currency: string;
  idempotencyKey: string;
  attempt: number;
  submittedAt: string;
  minutes: number;
  /** Whether Circle was asked this time: false when no provider could be had, or Circle did not answer. */
  circleAsked: boolean;
  /** Whether Circle answered the send itself: false for a send it never answered, which has no transaction id. */
  sendAnswered: boolean;
  /** Circle's state when asked: `STUCK`, `QUEUED`, `SENT`…; null when not asked. */
  providerState: string | null;
  txHash: string | null;
  network: string;
}

export async function watchStuckTransfers(deps: WatchDeps = {}): Promise<TransferWatchResult[]> {
  const now = (deps.now ?? Date.now)();
  // Every workspace, live or not: a sandbox with a hosted wallet pays for real when a person runs a cycle, and a payment
  // already sent can be stuck whatever the workspace's mode (D4). Payments in flight are read in each one's own scope.
  const orgs = unwrap(await platformDb().from("orgs").select("id, slug").order("slug")) as Array<{ id: string; slug: string }>;
  const results: TransferWatchResult[] = [];
  for (const org of orgs) {
    try {
      const result = await withOrg(org.id, () => watchWorkspace(org.slug, now, deps));
      if (result) results.push(result);
    } catch (error) {
      // One workspace's failure is its own, as in the schedule and the FX watch.
      const message = error instanceof Error ? error.message : String(error);
      console.error("transfer watch failed for", org.slug, message);
      results.push({ slug: org.slug, inFlight: 0, told: 0, error: message });
    }
  }
  return results;
}

/** One workspace's payments in flight past the shortest wait, told where still unconfirmed; null when there are none. */
async function watchWorkspace(slug: string, now: number, deps: WatchDeps): Promise<TransferWatchResult | null> {
  const inFlight = unwrap(
    await db()
      .from("payment_intents")
      .select("source_type, source_id, idempotency_key, provider_tx_id, tx_hash, amount, token, status, transfer_attempt, submitted_at, network")
      .in("status", ["submitting", "pending"])
      .eq("provider_mode", "live")
      .lt("submitted_at", new Date(now - SHORTEST_MINUTES * MINUTE_MS).toISOString())
      .order("submitted_at", { ascending: true })
  ) as InFlight[];
  if (inFlight.length === 0) return null;
  try {
    return { slug, inFlight: inFlight.length, told: await tellStuck(inFlight, now, deps) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("transfer watch failed for", slug, message);
    return { slug, inFlight: inFlight.length, told: 0, error: message };
  }
}

/** Tells each payment due by its own network's wait and not yet told; how many were told. */
async function tellStuck(inFlight: InFlight[], now: number, deps: WatchDeps): Promise<number> {
  // Each payment by its own network's wait (D1): the read used the shortest of them.
  const due = inFlight.filter((row) => now - Date.parse(row.submitted_at) >= networkProfile(networkOf(row.network)).stuckAfterMinutes * MINUTE_MS);
  if (due.length === 0) return 0;

  // Told once per attempt (D5): an entry for the attempt's key means it was told. The workflow runs one watch at a time.
  const toldKeys = new Set(
    (
      unwrap(
        await db()
          .from("ledger_entries")
          .select("detail")
          .eq("action", "payment_stuck")
          .in("detail->>idempotencyKey", due.map((row) => row.idempotency_key))
      ) as Array<{ detail: { idempotencyKey?: string } }>
    ).map((entry) => entry.detail.idempotencyKey)
  );
  const untold = due.filter((row) => !toldKeys.has(row.idempotency_key));
  if (untold.length === 0) return 0;

  const names = await payeeNames(untold);
  let provider: ChainProvider | null = null;
  try {
    provider = (deps.provider ?? getChainProvider)();
  } catch {
    // No provider here (credentials that cannot be read, or Arc mainnet switched off): told from the age alone (D4).
    provider = null;
  }

  const told: Told[] = [];
  for (const row of untold) {
    const sendAnswered = row.provider_tx_id !== null;
    let circleAsked = false;
    let providerState: string | null = null;
    if (sendAnswered && provider) {
      try {
        const answer = await provider.reconcileTransfer(row.provider_tx_id as string);
        // Settled by now, one way or the other: nothing to tell, and the next cycle records it (D10).
        if (answer.status !== "pending") continue;
        circleAsked = true;
        providerState = answer.providerState ?? null;
      } catch {
        // Circle did not answer this read: told from the age alone, rather than skipped forever (Review Focus 3).
        circleAsked = false;
      }
    }

    const network = networkOf(row.network);
    const minutes = Math.floor((now - Date.parse(row.submitted_at)) / MINUTE_MS);
    const amount = Number(row.amount);
    const currency = row.token ?? "USDC";
    const payee = names.get(`${row.source_type}:${row.source_id}`) ?? { name: "the payee", counterpartyId: null };
    const detail: StuckDetail = {
      ...(row.source_type === "invoice" ? { invoiceId: row.source_id } : { milestoneId: row.source_id }),
      counterpartyId: payee.counterpartyId,
      amount,
      currency,
      idempotencyKey: row.idempotency_key,
      attempt: row.transfer_attempt ?? 1,
      submittedAt: row.submitted_at,
      minutes,
      circleAsked,
      sendAnswered,
      providerState,
      txHash: row.tx_hash,
      network,
    };
    await appendLedgerEntry({
      actor: "agent",
      domain: row.source_type === "invoice" ? "ap" : "contractor",
      action: "payment_stuck",
      summary: `Payment of ${amount} ${currency} to ${payee.name} not confirmed ${minutes} min after it was sent on ${networkProfile(network).label}`,
      detail: { ...detail },
    });
    told.push({ detail, payeeName: payee.name });
  }
  await emailTold(told, deps);
  return told.length;
}

/**
 * Emails each deciding member with email notices on, one message for each payment told (D6): the digest's recipients,
 * at most as many. A failed send is logged and not retried: the signed entry, and the chats that carry it, still tell.
 * Never throws: the entries are written either way.
 */
async function emailTold(told: Told[], deps: WatchDeps): Promise<void> {
  if (told.length === 0) return;
  const settings = deps.mail && "settings" in deps.mail ? (deps.mail.settings ?? null) : emailSettingsFromEnv();
  const orgId = currentOrgId();
  if (!settings) {
    console.log("transfer watch: email not configured", orgId);
    return;
  }
  try {
    const recipients = (await (deps.mail?.recipients ?? decidingRecipients)(orgId)).slice(0, DIGEST_MAX_RECIPIENTS);
    if (recipients.length === 0) return;
    const org = unwrap(await platformDb().from("orgs").select("name, slug").eq("id", orgId).single()) as { name: string; slug: string };
    const origin = siteOrigin();
    const send = deps.mail?.send ?? ((message: EmailMessage, with_: { apiKey: string; from: string }) => sendEmail(message, with_));
    for (const { detail, payeeName } of told) {
      const network = networkOf(detail.network);
      const email = paymentStuckEmail({
        orgName: org.name,
        payeeName,
        amount: AMOUNT.format(detail.amount),
        currency: detail.currency,
        minutes: detail.minutes,
        network,
        circleAsked: detail.circleAsked,
        sendAnswered: detail.sendAnswered,
        providerState: detail.providerState,
        txUrl: detail.txHash ? txUrl(network, detail.txHash) : null,
        link: detail.invoiceId ? `${origin}/o/${org.slug}/invoices#trail-${detail.invoiceId}` : `${origin}/o/${org.slug}/contractors`,
        origin,
      });
      for (const recipient of recipients) {
        const result = await send({ to: recipient.email, ...email }, settings);
        // Say that a send failed, never to whom (as the digest does).
        if (!result.sent) console.warn("transfer watch: send failed", orgId, result.reason);
      }
    }
  } catch (error) {
    console.error("transfer watch: email failed", orgId, error instanceof Error ? error.message : String(error));
  }
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });

/** Each payment's payee, by `source_type:source_id`: an invoice's counterparty, or a milestone's contractor. */
async function payeeNames(rows: InFlight[]): Promise<Map<string, { name: string; counterpartyId: string | null }>> {
  const invoiceIds = rows.filter((row) => row.source_type === "invoice").map((row) => row.source_id);
  const milestoneIds = rows.filter((row) => row.source_type === "milestone").map((row) => row.source_id);
  const invoices = invoiceIds.length
    ? (unwrap(await db().from("invoices").select("id, counterparty_id").in("id", invoiceIds)) as Array<{ id: string; counterparty_id: string }>)
    : [];
  const milestones = milestoneIds.length
    ? (unwrap(await db().from("milestones").select("id, contractor_id, title").in("id", milestoneIds)) as Array<{ id: string; contractor_id: string; title: string }>)
    : [];
  const payeeOf = new Map<string, string>([
    ...invoices.map((invoice) => [`invoice:${invoice.id}`, invoice.counterparty_id] as [string, string]),
    ...milestones.map((milestone) => [`milestone:${milestone.id}`, milestone.contractor_id] as [string, string]),
  ]);
  const counterpartyIds = [...new Set(payeeOf.values())];
  const counterparties = counterpartyIds.length
    ? (unwrap(await db().from("counterparties").select("id, name").in("id", counterpartyIds)) as Array<{ id: string; name: string }>)
    : [];
  const nameOf = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty.name]));
  const names = new Map<string, { name: string; counterpartyId: string | null }>();
  for (const [source, counterpartyId] of payeeOf) names.set(source, { name: nameOf.get(counterpartyId) ?? "the payee", counterpartyId });
  return names;
}
