import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { runCycleSoon, type CycleEvent, type CycleEventKind } from "../agent/cycle-soon";
import { currentOrgConfig } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { notificationPublicKey, parseCircleNotification, verifyCircleSignature, type CircleNotification } from "./notifications";

/**
 * What a Circle notification starts (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2–N5). Only one
 * Circle signed, about a transfer a workspace is waiting on, starts that workspace's event cycle; the cycle reads Circle
 * back with the workspace's own credentials before it records anything (N1).
 */

/** Outbound states a transfer moves no further from: the cycle's reconcile reads which one it is (N4). */
const SETTLED = new Set(["COMPLETE", "FAILED", "DENIED", "CANCELLED"]);

export interface NotifyCandidate {
  id: string;
  slug: string;
  mode: "sandbox" | "live";
}

/** Seams for tests; production reads the database and Circle. */
export interface NotifyDeps {
  candidates?: () => Promise<NotifyCandidate[]>;
  inScope?: <T>(orgId: string, fn: () => Promise<T>) => Promise<T>;
  /** In the workspace's scope: a payment intent still in flight whose Circle transaction is this one. */
  inFlightIntent?: (txId: string) => Promise<boolean>;
  /** In the workspace's scope: one of its accounts holds this Circle wallet. */
  walletAccount?: (walletId: string) => Promise<boolean>;
  /** In the workspace's scope: Circle's public key for a key id, asked with the workspace's own Circle credentials. */
  fetchKey?: (keyId: string) => Promise<string>;
  raise?: (event: CycleEvent) => void;
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
  // Circle's test notification, another type, a state before settling: acknowledged, nothing to start.
  if (!kind) return { status: 200 };
  const named = kind === "payment_settled" ? envelope.notification.id : envelope.notification.walletId;
  if (!named) return { status: 200 };

  const inScope = deps.inScope ?? ((orgId, fn) => withOrg(orgId, fn));
  const waiting = kind === "payment_settled" ? (deps.inFlightIntent ?? inFlightIntent) : (deps.walletAccount ?? walletAccount);
  for (const org of await (deps.candidates ?? candidates)()) {
    let outcome: NotifyOutcome | null;
    try {
      outcome = await inScope(org.id, async () => {
        if (!(await waiting(named))) return null;
        let key: string;
        try {
          key = await notificationPublicKey(keyId, deps.fetchKey ?? fetchKeyInScope);
        } catch (error) {
          console.warn("Circle notification key not fetched for", org.slug, error instanceof Error ? error.message : String(error));
          return { status: 503 } satisfies NotifyOutcome;
        }
        if (!verifyCircleSignature(raw, signature, key)) return { status: 401 } satisfies NotifyOutcome;
        (deps.raise ?? runCycleSoon)({ orgId: org.id, sandbox: org.mode === "sandbox", kind });
        return { status: 200, started: { slug: org.slug, kind } } satisfies NotifyOutcome;
      });
    } catch (error) {
      // One workspace's failure is its own, as in the watches: the next may be the one.
      console.error("Circle notification: workspace not read", org.slug, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (outcome) return outcome;
  }
  return { status: 200 };
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
    await db().from("payment_intents").select("id").eq("provider_tx_id", txId).in("status", ["submitting", "pending"]).limit(1)
  ) as unknown[];
  return rows.length > 0;
}

async function walletAccount(walletId: string): Promise<boolean> {
  const rows = unwrap(await db().from("accounts").select("id").eq("circle_wallet_id", walletId).limit(1)) as unknown[];
  return rows.length > 0;
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
