import crypto from "node:crypto";
import { publicOrigin } from "../public-origin";

/**
 * Circle's signed transaction notifications (docs/superpowers/specs/2026-10-06-circle-notifications-design.md): what a
 * subscription asks for, the envelope Circle posts, and the signature it carries. A notification only starts work that
 * reads Circle back (N1): nothing here trusts what it says about money.
 */

/** Transfers out of and into a workspace's wallets (N6). */
export const NOTIFICATION_TYPES = ["transactions.outbound", "transactions.inbound"] as const;

/** Where every subscription Vestiarion makes points: one route for every Circle account (N2). */
export function notificationEndpoint(origin: string = publicOrigin()): string {
  return `${origin.replace(/\/+$/, "")}/api/circle/notifications`;
}

/** The part of a Transaction object a notification is matched on; the rest of the body is never read. */
export interface CircleTransactionNote {
  id?: string;
  walletId?: string;
  state?: string;
  transactionType?: string;
}

export interface CircleNotification {
  subscriptionId?: string;
  notificationId?: string;
  notificationType: string;
  notification: CircleTransactionNote;
  timestamp?: string;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Circle's envelope, or null for anything else. */
export function parseCircleNotification(raw: string): CircleNotification | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.notificationType !== "string" || !isRecord(value.notification)) return null;
  const note = value.notification;
  return {
    subscriptionId: text(value.subscriptionId),
    notificationId: text(value.notificationId),
    notificationType: value.notificationType,
    notification: { id: text(note.id), walletId: text(note.walletId), state: text(note.state), transactionType: text(note.transactionType) },
    timestamp: text(value.timestamp),
  };
}

/**
 * Whether Circle signed this exact body: ECDSA P-256 with SHA-256, the signature base64 DER (X-Circle-Signature), the
 * key base64 SPKI DER as Circle's `getNotificationSignature` answers it. False for anything malformed; never throws.
 */
export function verifyCircleSignature(raw: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return crypto.verify("sha256", Buffer.from(raw, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Public keys by Circle's key id, for the life of the instance: Circle says a key id's key never changes. */
const publicKeys = new Map<string, string>();

/** The public key for a key id, fetched once; a failed fetch is not remembered. */
export async function notificationPublicKey(keyId: string, fetchKey: (keyId: string) => Promise<string>): Promise<string> {
  const known = publicKeys.get(keyId);
  if (known) return known;
  const key = await fetchKey(keyId);
  publicKeys.set(keyId, key);
  return key;
}
