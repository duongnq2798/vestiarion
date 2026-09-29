import { platformDb } from "../dal";
import { decryptSecret, masterKeysFromEnv, type SecretEnvelope } from "../secrets";
import { createWebhookSender, WebhookSendError, type WebhookSender } from "./http";
import { assertPublicDestination, type LookupFn } from "./safe-url";
import { signWebhook } from "./sign";

/**
 * The webhook dispatcher (docs/superpowers/specs/2026-09-29-webhooks-design.md,
 * W3–W7, §5, §6).
 *
 * A run claims due deliveries through `claim_webhook_deliveries`, a few at a
 * time, and for each one:
 *
 * 1. reads the delivery again with its endpoint, its workspace's slug and its
 *    ledger entry, through `platformDb()`: the dispatcher runs outside any
 *    workspace, across all of them. An endpoint removed or disabled since the
 *    delivery was queued fails the delivery without sending (ruling R5);
 * 2. builds the §5 payload with `JSON.stringify` and signs exactly that string;
 * 3. decrypts the endpoint's secret under `webhook_secret:<endpoint id>`;
 * 4. checks the URL and every address its host resolves to
 *    (`assertPublicDestination`), then sends through the pinned `node:https`
 *    sender, which checks the addresses again and connects only to one it
 *    checked (ruling R4);
 * 5. records the result.
 *
 * Every result write is fenced on the claim it received — `id`,
 * `status = 'sending'` and the exact `claimed_at` — so a run whose claim went
 * stale and was taken over records nothing (ruling R6). Endpoint counters are
 * plain updates: a success resets `consecutive_failures`, a failure goes
 * through `record_webhook_failure`, which disables the endpoint at
 * `WEBHOOK_DISABLE_AFTER` and fails its pending deliveries.
 *
 * Nothing here throws, and logs carry delivery and endpoint ids and fixed
 * reasons only: never the secret, the URL or anything the receiver answered.
 */

/** Wait after attempts 1..6 before the next one (W5). */
export const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
export const WEBHOOK_MAX_ATTEMPTS = 7;
export const WEBHOOK_DISABLE_AFTER = 20;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** W7: a run sends at most this many deliveries, and stops after `WEBHOOK_RUN_DEADLINE_MS`. */
export const WEBHOOK_RUN_LIMIT = 50;
export const WEBHOOK_RUN_DEADLINE_MS = 60_000;
/** How many deliveries one claim takes, so a run holds few claims it has not reached yet. */
const CLAIM_BATCH = 10;
/** A delivery that could not be prepared (our side, not the receiver's) waits this long, uncounted. */
const RELEASE_DELAY_MS = 60_000;

const USER_AGENT = "Vestiarion-Webhooks/1";

export interface DeliverOptions {
  limit?: number;
  deadlineMs?: number;
  /** The sender; the pinned `node:https` one by default. */
  send?: WebhookSender;
  /** DNS resolution, for the destination check and the default sender. */
  lookup?: LookupFn;
  now?: () => Date;
}

export interface DeliverResult {
  delivered: number;
  failed: number;
  retried: number;
}

type EventType = "ledger.appended" | "webhook.test";

interface ClaimedDelivery {
  id: string;
  org_id: string;
  endpoint_id: string;
  ledger_entry_id: string | null;
  event_type: EventType;
  attempts: number;
  claimed_at: string;
  created_at: string;
}

interface EndpointForSend {
  id: string;
  org_id: string;
  url: string;
  secret_enc: SecretEnvelope;
  removed_at: string | null;
  disabled_at: string | null;
}

interface LedgerRow {
  seq: number | string;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown> | null;
  body_hash: string;
  prev_hash: string;
  hash: string;
  signature: string;
  signing_key_id: string | null;
}

interface DeliveryForSend {
  id: string;
  endpoint: EndpointForSend | null;
  org: { slug: string } | null;
  entry: LedgerRow | null;
}

const SEND_COLUMNS =
  "id, endpoint:webhook_endpoints(id, org_id, url, secret_enc, removed_at, disabled_at), org:orgs(slug), " +
  "entry:ledger_entries(seq, ts, actor, domain, action, summary, detail, body_hash, prev_hash, hash, signature, signing_key_id)";

/**
 * - `delivered`, `retried` (back to pending with a backoff) and `failed`
 *   (for good) are counted;
 * - `released` went back to pending unsent, attempts unchanged;
 * - `lost` means the claim was taken over, or the write failed, so nothing
 *   was recorded.
 */
type Outcome =
  | { kind: "delivered"; status: number }
  | { kind: "retried" | "failed"; status: number | null; reason: string }
  | { kind: "released" | "lost"; status: number | null; reason: string };

interface Run {
  send: WebhookSender;
  lookup?: LookupFn;
  now: () => Date;
}

/** The §5 payload, as the exact string that is signed and sent. */
function payloadOf(delivery: ClaimedDelivery, slug: string, entry: LedgerRow | null): string {
  const base = {
    id: delivery.id,
    type: delivery.event_type,
    createdAt: entry ? String(entry.ts) : String(delivery.created_at),
    workspace: { slug },
  };
  if (!entry) return JSON.stringify(base);
  return JSON.stringify({
    ...base,
    entry: {
      seq: Number(entry.seq),
      ts: String(entry.ts),
      actor: entry.actor,
      domain: entry.domain,
      action: entry.action,
      summary: entry.summary,
      detail: entry.detail ?? {},
      bodyHash: entry.body_hash,
      prevHash: entry.prev_hash,
      hash: entry.hash,
      signature: entry.signature,
      signingKeyId: entry.signing_key_id ?? null,
    },
  });
}

/** Writes the result of a claimed delivery, only while the claim is still this run's (R6). */
async function writeClaimed(delivery: ClaimedDelivery, values: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await platformDb()
    .from("webhook_deliveries")
    .update(values)
    .eq("id", delivery.id)
    .eq("status", "sending")
    .eq("claimed_at", delivery.claimed_at)
    .select("id");
  if (error) {
    console.error("webhook delivery result not recorded", delivery.id, delivery.endpoint_id);
    return false;
  }
  if (!data || data.length === 0) {
    console.warn("webhook delivery claim was taken over; result not recorded", delivery.id, delivery.endpoint_id);
    return false;
  }
  return true;
}

/** Hands an unsent delivery back to the queue with its attempt count unchanged. */
async function release(delivery: ClaimedDelivery, run: Run, delayMs: number, reason: string): Promise<Outcome> {
  const values: Record<string, unknown> = { status: "pending", claimed_at: null };
  if (delayMs > 0) values.next_attempt_at = new Date(run.now().getTime() + delayMs).toISOString();
  const recorded = await writeClaimed(delivery, values);
  return { kind: recorded ? "released" : "lost", status: null, reason };
}

/** Fails a delivery for good without an attempt: nothing was sent. */
async function abandon(delivery: ClaimedDelivery, reason: string): Promise<Outcome> {
  const recorded = await writeClaimed(delivery, { status: "failed", last_error: reason });
  if (recorded) console.warn("webhook delivery abandoned", delivery.id, delivery.endpoint_id, reason);
  return recorded ? { kind: "failed", status: null, reason } : { kind: "lost", status: null, reason };
}

async function succeeded(delivery: ClaimedDelivery, run: Run, status: number): Promise<Outcome> {
  const at = run.now().toISOString();
  const recorded = await writeClaimed(delivery, {
    status: "delivered", attempts: delivery.attempts + 1, delivered_at: at, last_status: status, last_error: null,
  });
  if (!recorded) return { kind: "lost", status, reason: "not recorded" };
  const { error } = await platformDb()
    .from("webhook_endpoints")
    .update({ consecutive_failures: 0, last_success_at: at })
    .eq("id", delivery.endpoint_id)
    .is("disabled_at", null);
  if (error) console.error("webhook endpoint success not recorded", delivery.endpoint_id, delivery.id);
  return { kind: "delivered", status };
}

async function attemptFailed(delivery: ClaimedDelivery, run: Run, status: number | null, reason: string): Promise<Outcome> {
  const attempts = delivery.attempts + 1;
  const final = attempts >= WEBHOOK_MAX_ATTEMPTS;
  const values: Record<string, unknown> = final
    ? { status: "failed", attempts, last_status: status, last_error: reason }
    : {
        status: "pending", attempts, claimed_at: null, last_status: status, last_error: reason,
        next_attempt_at: new Date(run.now().getTime() + WEBHOOK_BACKOFF_MS[attempts - 1]).toISOString(),
      };
  if (!(await writeClaimed(delivery, values))) return { kind: "lost", status, reason };
  console.warn("webhook delivery attempt failed", delivery.id, delivery.endpoint_id, attempts, reason);

  const { data, error } = await platformDb().rpc("record_webhook_failure", {
    p_endpoint_id: delivery.endpoint_id,
    p_disable_after: WEBHOOK_DISABLE_AFTER,
  });
  if (error) {
    console.error("webhook endpoint failure not recorded", delivery.endpoint_id, delivery.id);
  } else if (typeof data === "number" && data >= WEBHOOK_DISABLE_AFTER) {
    console.warn("webhook endpoint disabled after repeated failures", delivery.endpoint_id);
    // Disabling failed the endpoint's pending deliveries, this one included.
    return { kind: "failed", status, reason };
  }
  return { kind: final ? "failed" : "retried", status, reason };
}

/** Prepares, signs and sends one claimed delivery, and records the result. */
async function deliverClaimed(delivery: ClaimedDelivery, run: Run): Promise<Outcome> {
  // A run that died mid-send on this row every time still reaches the limit:
  // each takeover of a stale claim counted one attempt (R6).
  if (delivery.attempts >= WEBHOOK_MAX_ATTEMPTS) return abandon(delivery, "too many attempts");

  const read = await platformDb()
    .from("webhook_deliveries")
    .select(SEND_COLUMNS)
    .eq("id", delivery.id)
    .maybeSingle<DeliveryForSend>();
  if (read.error) {
    console.error("webhook delivery could not be read", delivery.id, delivery.endpoint_id);
    return release(delivery, run, RELEASE_DELAY_MS, "could not be read");
  }
  const row = read.data;
  if (!row) return { kind: "lost", status: null, reason: "gone" };

  const endpoint = row.endpoint;
  if (!endpoint || endpoint.removed_at) return abandon(delivery, "endpoint removed");
  if (endpoint.disabled_at) return abandon(delivery, "endpoint disabled");
  if (endpoint.org_id !== delivery.org_id) return abandon(delivery, "endpoint belongs to another workspace");
  if (delivery.event_type === "ledger.appended" && !row.entry) return abandon(delivery, "event unavailable");
  if (!row.org?.slug) {
    console.error("webhook delivery workspace could not be read", delivery.id, delivery.endpoint_id);
    return release(delivery, run, RELEASE_DELAY_MS, "could not be read");
  }

  const body = payloadOf(delivery, row.org.slug, delivery.event_type === "ledger.appended" ? row.entry : null);

  let secret: string;
  try {
    secret = decryptSecret(endpoint.secret_enc, { orgId: endpoint.org_id, column: `webhook_secret:${endpoint.id}` }, masterKeysFromEnv());
  } catch {
    console.error("webhook secret unavailable", endpoint.id, delivery.id);
    return attemptFailed(delivery, run, null, "secret unavailable");
  }

  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return attemptFailed(delivery, run, null, "not a valid URL");
  }
  const destination = await assertPublicDestination(url, run.lookup);
  if (!destination.ok) return attemptFailed(delivery, run, null, destination.reason);

  const t = Math.floor(run.now().getTime() / 1000);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "Vestiarion-Event-Id": delivery.id,
    "Vestiarion-Event-Type": delivery.event_type,
    "Vestiarion-Signature": signWebhook(secret, body, t),
  };

  let status: number;
  try {
    status = (await run.send({ url: destination.url, headers, body, timeoutMs: WEBHOOK_TIMEOUT_MS })).status;
  } catch (error) {
    return attemptFailed(delivery, run, null, error instanceof WebhookSendError ? error.reason : "request failed");
  }
  if (status >= 200 && status < 300) return succeeded(delivery, run, status);
  if (status >= 300 && status < 400) return attemptFailed(delivery, run, status, `redirect not followed (HTTP ${status})`);
  return attemptFailed(delivery, run, status, `HTTP ${status}`);
}

/** `deliverClaimed`, which also never throws: an unexpected error hands the delivery back. */
async function deliverSafely(delivery: ClaimedDelivery, run: Run): Promise<Outcome> {
  try {
    return await deliverClaimed(delivery, run);
  } catch {
    console.error("webhook delivery failed unexpectedly", delivery.id, delivery.endpoint_id);
    try {
      return await release(delivery, run, RELEASE_DELAY_MS, "unexpected error");
    } catch {
      return { kind: "lost", status: null, reason: "unexpected error" };
    }
  }
}

function runOf(options: DeliverOptions): Run {
  return {
    send: options.send ?? createWebhookSender({ resolve: options.lookup }),
    lookup: options.lookup,
    now: options.now ?? (() => new Date()),
  };
}

function tally(result: DeliverResult, outcome: Outcome): void {
  if (outcome.kind === "delivered") result.delivered += 1;
  else if (outcome.kind === "failed") result.failed += 1;
  else if (outcome.kind === "retried") result.retried += 1;
}

/**
 * Sends due deliveries until `limit` are taken, the queue is empty or the
 * deadline passes. Claimed deliveries not reached by the deadline go back to
 * pending with their attempt count. Never throws.
 */
export async function deliverPendingWebhooks(options: DeliverOptions = {}): Promise<DeliverResult> {
  const result: DeliverResult = { delivered: 0, failed: 0, retried: 0 };
  try {
    const run = runOf(options);
    const limit = Math.max(0, Math.floor(options.limit ?? WEBHOOK_RUN_LIMIT));
    const deadline = run.now().getTime() + (options.deadlineMs ?? WEBHOOK_RUN_DEADLINE_MS);
    const passed = () => run.now().getTime() >= deadline;

    let taken = 0;
    while (taken < limit && !passed()) {
      const { data, error } = await platformDb().rpc("claim_webhook_deliveries", {
        p_limit: Math.min(CLAIM_BATCH, limit - taken),
      });
      if (error) {
        console.error("could not claim webhook deliveries", error.message);
        break;
      }
      const claimed = (data ?? []) as ClaimedDelivery[];
      if (claimed.length === 0) break;
      taken += claimed.length;

      for (const delivery of claimed) {
        if (passed()) {
          try {
            await release(delivery, run, 0, "deadline");
          } catch {
            console.error("webhook delivery not handed back", delivery.id, delivery.endpoint_id);
          }
          continue;
        }
        tally(result, await deliverSafely(delivery, run));
      }
    }
  } catch {
    console.error("webhook dispatch failed");
  }
  return result;
}

export interface TestEventResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * Queues a `webhook.test` delivery for one of the workspace's active
 * endpoints, claims exactly that row and delivers it through the same path as
 * every other delivery, retries included. The row is inserted `pending` and
 * claimed through `claim_webhook_deliveries`, so it is never `sending` without
 * a claim (R6). Never throws.
 */
export async function sendTestEvent(
  input: { orgId: string; endpointId: string },
  options: Omit<DeliverOptions, "limit" | "deadlineMs"> = {}
): Promise<TestEventResult> {
  try {
    const found = await platformDb()
      .from("webhook_endpoints")
      .select("id, removed_at, disabled_at")
      .eq("id", input.endpointId)
      .eq("org_id", input.orgId)
      .maybeSingle<{ id: string; removed_at: string | null; disabled_at: string | null }>();
    if (found.error) throw new Error("endpoint could not be read");
    if (!found.data || found.data.removed_at) return { ok: false, status: null, error: "endpoint not found" };
    if (found.data.disabled_at) return { ok: false, status: null, error: "endpoint is disabled" };

    const inserted = await platformDb()
      .from("webhook_deliveries")
      .insert({ org_id: input.orgId, endpoint_id: input.endpointId, event_type: "webhook.test" })
      .select("id")
      .single<{ id: string }>();
    if (inserted.error || !inserted.data) throw new Error("test event could not be queued");

    const claim = await platformDb().rpc("claim_webhook_deliveries", { p_limit: 1, p_only: inserted.data.id });
    if (claim.error) throw new Error("test event could not be claimed");
    const [delivery] = (claim.data ?? []) as ClaimedDelivery[];
    // Another run claimed it first; it will be delivered by that run.
    if (!delivery) return { ok: false, status: null, error: "queued for the next dispatch" };

    const outcome = await deliverSafely(delivery, runOf(options));
    if (outcome.kind === "delivered") return { ok: true, status: outcome.status, error: null };
    return { ok: false, status: outcome.status, error: outcome.reason };
  } catch {
    console.error("webhook test event failed", input.endpointId);
    return { ok: false, status: null, error: "could not send the test event" };
  }
}
