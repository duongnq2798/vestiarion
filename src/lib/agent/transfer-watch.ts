import { siteOrigin } from "../auth/env";
import { getChainProvider } from "../circle";
import type { ChainProvider } from "../circle/types";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { paymentStuckEmail, type StuckPayment } from "../email/payment-stuck";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { NETWORK_IDS, networkOf, networkProfile } from "../network";
import { DIGEST_MAX_RECIPIENTS, decidingRecipients } from "../notifications/waiting";
import { txUrl } from "../payee-chains";
import { sendSlackDecisions } from "../slack/notify";
import { sendAgentDecisions } from "../telegram/notify";
import { paymentWasSent } from "./approvals";

/**
 * The transfer watch (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md): every 5 minutes it finds the
 * live payments whose current attempt was sent longer ago than their network's `stuckAfterMinutes`, asks Circle again,
 * read-only, and signs a `payment_stuck` entry for each still unconfirmed, once per attempt (D5). It then posts them to
 * the workspace's Telegram chats and Slack channel at once, and emails its deciding members (D6); the console's toasts and
 * webhooks carry the entries as they carry the agent's decisions.
 *
 * It reads and tells: it never sends, retries, settles or holds anything, and it writes no payment, invoice or milestone.
 * The cycle keeps doing that. It runs whatever the switches say (D4): a payment already sent can be stuck while payments
 * are off, the agent is paused or Arc mainnet is switched off, and that is when a person most needs to know.
 */

/** The shortest wait of any network: the watch reads what was sent before it, then holds each to its own network's. */
const SHORTEST_MINUTES = Math.min(...NETWORK_IDS.map((id) => networkProfile(id).stuckAfterMinutes));
const MINUTE_MS = 60_000;
/** How far back a payment recorded failed may still have moved and be told (final review I2): one told is told once. */
const FAILED_LOOKBACK_MS = 7 * 24 * 60 * MINUTE_MS;

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
  last_error: string | null;
  provider_state: string | null;
  payout_route: string | null;
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
  // Every workspace that can hold a live payment, live or not: one with a hosted wallet or its own Circle credentials
  // (mainnet polish E6). A sandbox with a hosted wallet pays for real when a person runs a cycle, and a payment already
  // sent can be stuck whatever the workspace's mode (D4). Payments in flight are read in each one's own scope.
  const orgs = unwrap(
    await platformDb().from("orgs").select("id, slug").or("wallet_host.not.is.null,circle_api_key_enc.not.is.null").order("slug")
  ) as Array<{ id: string; slug: string }>;
  const results: TransferWatchResult[] = [];
  for (const org of orgs) {
    try {
      const result = await withOrg(org.id, () => watchWorkspace(org.slug, now, deps));
      if (result) results.push(result);
    } catch (error) {
      // One workspace's failure is its own, as in the schedule and the FX watch.
      const message = messageOf(error);
      console.error("transfer watch failed for", org.slug, message);
      results.push({ slug: org.slug, inFlight: 0, told: 0, error: message });
    }
  }
  return results;
}

/** One workspace's payments in flight past the shortest wait, told where still unconfirmed; null when there are none. */
async function watchWorkspace(slug: string, now: number, deps: WatchDeps): Promise<TransferWatchResult | null> {
  const read = unwrap(
    await db()
      .from("payment_intents")
      .select("source_type, source_id, idempotency_key, provider_tx_id, tx_hash, amount, token, status, transfer_attempt, submitted_at, network, last_error, provider_state, payout_route")
      // In flight, or recorded failed in the last week though it may have moved (final review I2): a send whose answer
      // was lost, or a transfer whose last read failed, which `paymentWasSent` keeps below.
      .or(`status.in.(submitting,pending),and(status.eq.failed,submitted_at.gt.${new Date(now - FAILED_LOOKBACK_MS).toISOString()})`)
      .eq("provider_mode", "live")
      .lt("submitted_at", new Date(now - SHORTEST_MINUTES * MINUTE_MS).toISOString())
      .order("submitted_at", { ascending: true })
  ) as InFlight[];
  const inFlight = read.filter((row) => row.status !== "failed" || paymentWasSent(row));
  if (inFlight.length === 0) return null;
  const { told, error } = await tellStuck(slug, inFlight, now, deps);
  return { slug, inFlight: inFlight.length, told, ...(error ? { error } : {}) };
}

/**
 * Tells each payment due by its own network's wait and not yet told. A payment whose entry cannot be written is logged and
 * the rest are told (final review I3); whatever was signed is then emailed and posted to the chats.
 */
async function tellStuck(slug: string, inFlight: InFlight[], now: number, deps: WatchDeps): Promise<{ told: number; error?: string }> {
  // Each payment by its own network's wait (D1): the read used the shortest of them.
  const due = inFlight.filter((row) => now - Date.parse(row.submitted_at) >= networkProfile(networkOf(row.network)).stuckAfterMinutes * MINUTE_MS);
  if (due.length === 0) return { told: 0 };

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
  if (untold.length === 0) return { told: 0 };

  // A name is for people to read; one that cannot be read is "the payee", and the payment is still told (final review I3).
  const names = await payeeNames(untold).catch((reason: unknown) => {
    console.error("transfer watch: payee names not read for", slug, messageOf(reason));
    return new Map<string, { name: string; counterpartyId: string | null }>();
  });
  let provider: ChainProvider | null = null;
  try {
    provider = (deps.provider ?? getChainProvider)();
  } catch {
    // No provider here (credentials that cannot be read, or Arc mainnet switched off): told from the age alone (D4).
    provider = null;
  }

  const told: Told[] = [];
  let error: string | undefined;
  for (const row of untold) {
    try {
      const sendAnswered = row.provider_tx_id !== null;
      let circleAsked = false;
      let providerState: string | null = null;
      let answeredTx: string | null = null;
      // Only a live provider is asked: a simulator would answer "confirmed" for any payment (mainnet polish E7).
      if (sendAnswered && provider && provider.mode === "live") {
        try {
          const answer = await provider.reconcileTransfer(row.provider_tx_id as string);
          // Settled by now, one way or the other: nothing to tell, and the next cycle records it (D10).
          if (answer.status !== "pending") continue;
          circleAsked = true;
          providerState = answer.providerState ?? null;
          answeredTx = answer.txHash ?? null;
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
        // Circle's answer, when the row has no hash yet (E7).
        txHash: row.tx_hash ?? answeredTx,
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
    } catch (reason) {
      // This payment's entry was not written: it is told on the next run. The others still are (final review I3).
      error = messageOf(reason);
      console.error("transfer watch: payment not told in", slug, row.idempotency_key, error);
    }
  }

  if (told.length > 0) {
    await emailTold(told, deps);
    await postToChats(slug);
  }
  return { told: told.length, ...(error ? { error } : {}) };
}

/**
 * Posts the signed entries to the workspace's Telegram chats and Slack channel at once (final review I1), rather than at
 * the next cycle, which may be hours away or, while the agent is paused or payments are off, never. Each reads from its
 * own cursor, as the cycle's stages do. A chat that fails is logged: the entries, the email and the console still tell.
 */
async function postToChats(slug: string): Promise<void> {
  for (const [name, post] of [
    ["telegram", sendAgentDecisions],
    ["slack", sendSlackDecisions],
  ] as const) {
    try {
      await post();
    } catch (reason) {
      console.error(`transfer watch: ${name} not posted for`, slug, messageOf(reason));
    }
  }
}

/**
 * Emails each deciding member with email notices on one message listing every payment told this run (D6, final review
 * M1): the digest's recipients, at most as many. A failed send is logged and not retried: the signed entry, and the
 * chats that carry it, still tell. Never throws: the entries are written either way.
 */
async function emailTold(told: Told[], deps: WatchDeps): Promise<void> {
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
    const payments: StuckPayment[] = told.map(({ detail, payeeName }) => {
      const network = networkOf(detail.network);
      return {
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
      };
    });
    const email = paymentStuckEmail({ orgName: org.name, payments, link: payments.length === 1 ? payments[0].link : `${origin}/o/${org.slug}/invoices`, origin });
    const send = deps.mail?.send ?? ((message: EmailMessage, with_: { apiKey: string; from: string }) => sendEmail(message, with_));
    for (const recipient of recipients) {
      const result = await send({ to: recipient.email, ...email }, settings);
      // Say that a send failed, never to whom (as the digest does).
      if (!result.sent) console.warn("transfer watch: send failed", orgId, result.reason);
    }
  } catch (reason) {
    console.error("transfer watch: email failed", orgId, messageOf(reason));
  }
}

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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });
