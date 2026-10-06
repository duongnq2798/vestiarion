import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { runCycleSoon, type CycleEvent, type CycleEventKind } from "../agent/cycle-soon";
import { recordIncomingTransfers } from "../agent/receipts";
import { currentOrgConfig } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { circleFailureLabel } from "./check";
import { getChainProvider } from "./index";
import { notificationPublicKey, parseCircleNotification, verifyCircleSignature, type CircleNotification } from "./notifications";

/**
 * What a Circle notification starts (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2–N5). Only one
 * Circle signed, about a transfer a workspace is waiting on, starts work; the work reads Circle back with the
 * workspace's own credentials before it records anything (N1).
 */

/** Outbound states a transfer moves no further from: the cycle's reconcile reads which one it is (N4). */
const SETTLED = new Set(["COMPLETE", "FAILED", "DENIED", "CANCELLED"]);

/**
 * Intents a settled transfer can still change: in flight, or recorded failed while the transfer may have moved (a send
 * whose answer was lost), which the AP stage reconciles too (final review M7).
 */
const WAITING_STATUSES = ["submitting", "pending", "failed"] as const;

/** A workspace's inbound transfers are read at most once in this long, however often money arrives (final review I2). */
const INBOUND_COOLDOWN_MS = 15_000;
const lastInboundRead = new Map<string, number>();

export interface NotifyCandidate {
  id: string;
  slug: string;
  mode: "sandbox" | "live";
}

/** Seams for tests; production reads the database and Circle. */
export interface NotifyDeps {
  candidates?: () => Promise<NotifyCandidate[]>;
  inScope?: <T>(orgId: string, fn: () => Promise<T>) => Promise<T>;
  /** In the workspace's scope: a payment intent this Circle transaction can still change. */
  inFlightIntent?: (txId: string) => Promise<boolean>;
  /** In the workspace's scope: the operating account that holds this Circle wallet, or null. */
  operatingAccount?: (walletId: string) => Promise<string | null>;
  /** In the workspace's scope: Circle's public key for a key id, asked with the workspace's own Circle credentials. */
  fetchKey?: (keyId: string) => Promise<string>;
  /** In the workspace's scope: reads its inbound transfers now, as the pay page's check does; the receivables they paid. */
  recordInbound?: (operatingAccountId: string) => Promise<number>;
  raise?: (event: CycleEvent) => void;
  now?: () => number;
}

export interface NotifyOutcome {
  status: 200 | 400 | 401 | 503;
  started?: { slug: string; kind: CycleEventKind };
}

export async function handleCircleNotification(
  raw: string,
  headers: { signature: string | null; keyId: string | null },
  deps: NotifyDeps = {}
): Promise<NotifyOutcome> {
  const envelope = parseCircleNotification(raw);
  // Circle makes a subscription only once the endpoint answers its test notification with a 2xx; it starts nothing, so
  // it is answered before the headers are looked at.
  if (envelope?.notificationType === "webhooks.test") return { status: 200 };
  const { signature, keyId } = headers;
  if (!signature || !keyId) return { status: 401 };
  if (!envelope) return { status: 400 };
  const kind = eventFor(envelope);
  // Another type, or a state before settling: acknowledged, nothing to start.
  if (!kind) return { status: 200 };
  const named = kind === "payment_settled" ? envelope.notification.id : envelope.notification.walletId;
  if (!named) return { status: 200 };

  const inScope = deps.inScope ?? ((orgId, fn) => withOrg(orgId, fn));
  const now = (deps.now ?? Date.now)();
  let unread = 0;
  for (const org of await (deps.candidates ?? candidates)()) {
    let outcome: NotifyOutcome | null;
    try {
      outcome = await inScope(org.id, async () => {
        const account = kind === "payment_settled" ? ((await (deps.inFlightIntent ?? inFlightIntent)(named)) ? named : null) : await (deps.operatingAccount ?? operatingAccount)(named);
        if (!account) return null;
        let key: string;
        try {
          key = await notificationPublicKey(keyId, deps.fetchKey ?? fetchKeyInScope);
        } catch (error) {
          console.warn("Circle notification key not fetched for", org.slug, circleFailureLabel(error));
          return { status: 503 } satisfies NotifyOutcome;
        }
        if (!verifyCircleSignature(raw, signature, key)) return { status: 401 } satisfies NotifyOutcome;
        if (kind === "payment_received") {
          // Money in starts a cycle only when it paid a receivable: dust, a funding transfer or the agent's own moves
          // would otherwise each cost a cycle (final review I2). Read at most once in 15 seconds per workspace.
          const last = lastInboundRead.get(org.id);
          if (last !== undefined && now - last < INBOUND_COOLDOWN_MS) return { status: 200 } satisfies NotifyOutcome;
          lastInboundRead.set(org.id, now);
          if ((await (deps.recordInbound ?? recordInbound)(account)) === 0) return { status: 200 } satisfies NotifyOutcome;
        }
        (deps.raise ?? runCycleSoon)({ orgId: org.id, sandbox: org.mode === "sandbox", kind });
        return { status: 200, started: { slug: org.slug, kind } } satisfies NotifyOutcome;
      });
    } catch (error) {
      // One workspace's failure is its own, as in the watches: the next may be the one.
      unread += 1;
      console.error("Circle notification: workspace not read", org.slug, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (outcome) return outcome;
  }
  // A workspace that could not be read may be the one: Circle sends the notification again (final review M7).
  return { status: unread > 0 ? 503 : 200 };
}

/** The cycle event a notification calls for, or null (N4). */
function eventFor(envelope: CircleNotification): CycleEventKind | null {
  const { state } = envelope.notification;
  if (envelope.notificationType === "transactions.outbound" && state && SETTLED.has(state)) return "payment_settled";
  if (envelope.notificationType === "transactions.inbound" && state === "COMPLETE") return "payment_received";
  return null;
}

/** Every workspace that can hold a live payment, as the transfer watch lists them (N3). */
async function candidates(): Promise<NotifyCandidate[]> {
  return unwrap(
    await platformDb().from("orgs").select("id, slug, mode").or("wallet_host.not.is.null,circle_api_key_enc.not.is.null").order("slug")
  ) as NotifyCandidate[];
}

async function inFlightIntent(txId: string): Promise<boolean> {
  const rows = unwrap(
    await db().from("payment_intents").select("id").eq("provider_tx_id", txId).in("status", [...WAITING_STATUSES]).limit(1)
  ) as unknown[];
  return rows.length > 0;
}

/** The operating account only: the receipts stage reads it, and money anywhere else pays no receivable (final review I2). */
async function operatingAccount(walletId: string): Promise<string | null> {
  const rows = unwrap(await db().from("accounts").select("id").eq("circle_wallet_id", walletId).eq("kind", "operating").limit(1)) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

async function recordInbound(operatingAccountId: string): Promise<number> {
  return (await recordIncomingTransfers(db(), getChainProvider(), operatingAccountId)).matched;
}

/** Circle's public key for a key id, asked of the account the notification is about: the scope's own credentials. */
async function fetchKeyInScope(keyId: string): Promise<string> {
  const { circleApiKey, circleEntitySecret } = currentOrgConfig().chain;
  if (!circleApiKey || !circleEntitySecret) throw new Error("the workspace's Circle credentials cannot be read");
  const answer = await initiateDeveloperControlledWalletsClient({ apiKey: circleApiKey, entitySecret: circleEntitySecret }).getNotificationSignature(keyId);
  const key = answer.data?.publicKey;
  if (!key) throw new Error("Circle named no public key");
  return key;
}
