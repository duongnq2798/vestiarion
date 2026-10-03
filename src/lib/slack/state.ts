import crypto from "node:crypto";
import type { MasterKey } from "../secrets";

/**
 * What Vestiarion signs and Slack carries back (Slack design S3, S9): the OAuth state that ties an install to the
 * person who started it, and the card a button carries. Each is `vx1.<base64url JSON>.<base64url HMAC-SHA256>`, keyed
 * by HKDF from the master key with its own purpose, so one can never be read as the other; it is signed with the
 * current master key and checked against every one, so a rotation does not break a card already posted. Each expires.
 * Pure: no I/O.
 */

type Purpose = "slack-oauth-state" | "chat-card";

const TOKEN = /^vx1\.([A-Za-z0-9_-]{8,1500})\.([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A card is good for a week: after that a stopped payable is decided in the console. */
export const CARD_TTL_MS = 7 * 24 * 60 * 60_000;
/** An install must come back from Slack within ten minutes. */
export const STATE_TTL_MS = 10 * 60_000;

function keyFor(master: MasterKey, purpose: Purpose): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", master.key, Buffer.alloc(0), `vestiarion/${purpose}/v1`, 32));
}

function mac(master: MasterKey, purpose: Purpose, body: string): Buffer {
  return crypto.createHmac("sha256", keyFor(master, purpose)).update(`${purpose}.${body}`, "utf8").digest();
}

function sign(purpose: Purpose, payload: Record<string, unknown>, keys: MasterKey[]): string {
  const current = keys[0];
  if (!current) throw new Error("no master key to sign with");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `vx1.${body}.${mac(current, purpose, body).toString("base64url")}`;
}

function open(purpose: Purpose, token: string, keys: MasterKey[], nowMs: number): Record<string, unknown> | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, body, signature] = match;
  const given = Buffer.from(signature, "base64url");
  const signed = keys.some((key) => {
    const expected = mac(key, purpose, body);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
  if (!signed) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return typeof record.x === "number" && record.x > nowMs ? record : null;
}

/** A payable as a card showed it: its workspace, its id, when it was decided, and its payee's address (hashed). */
export interface Card {
  org: string;
  invoice: string;
  decidedAt: string | null;
  addressHash: string | null;
}

export function cardToken(card: Card, keys: MasterKey[], nowMs: number = Date.now()): string {
  return sign("chat-card", { o: card.org, i: card.invoice, d: card.decidedAt, a: card.addressHash, x: nowMs + CARD_TTL_MS }, keys);
}

export function readCard(token: string, keys: MasterKey[], nowMs: number = Date.now()): Card | null {
  const payload = open("chat-card", token, keys, nowMs);
  if (!payload) return null;
  const { o, i, d, a } = payload;
  if (typeof o !== "string" || !UUID.test(o) || typeof i !== "string" || !UUID.test(i)) return null;
  if (d !== null && typeof d !== "string") return null;
  if (a !== null && (typeof a !== "string" || !/^[0-9a-f]{16}$/.test(a))) return null;
  return { org: o, invoice: i, decidedAt: d, addressHash: a };
}

/** Who started an install, for which workspace, and the nonce also kept in their browser's cookie. */
export interface OAuthState {
  org: string;
  user: string;
  nonce: string;
}

export function oauthState(state: OAuthState, keys: MasterKey[], nowMs: number = Date.now()): string {
  return sign("slack-oauth-state", { o: state.org, u: state.user, n: state.nonce, x: nowMs + STATE_TTL_MS }, keys);
}

export function readOAuthState(token: string, keys: MasterKey[], nowMs: number = Date.now()): OAuthState | null {
  const payload = open("slack-oauth-state", token, keys, nowMs);
  if (!payload) return null;
  const { o, u, n } = payload;
  if (typeof o !== "string" || !UUID.test(o) || typeof u !== "string" || !UUID.test(u)) return null;
  if (typeof n !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(n)) return null;
  return { org: o, user: u, nonce: n };
}

/** A random nonce for the OAuth cookie: 32 bytes in base64url. */
export function newNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** The address a card was posted with, as it carries it: the first 16 hex of its SHA-256, any case; null for none. */
export function addressHash(address: string | null): string | null {
  if (!address) return null;
  return crypto.createHash("sha256").update(address.toLowerCase(), "utf8").digest("hex").slice(0, 16);
}
