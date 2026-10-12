import crypto from "node:crypto";
import type { MasterKey } from "../secrets";
import { PROVIDERS, type ProviderId } from "./provider";

/**
 * The OAuth state an accounting provider carries back (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4):
 * `vx1.<base64url JSON>.<base64url HMAC-SHA256>`, keyed by HKDF from the master key for this purpose alone, as Slack's
 * and GitHub's states are, so no other token reads as one. It names the provider, the workspace, the person, a nonce
 * also kept in their browser's cookie, and the consent they gave; it expires after ten minutes. Signed with the current
 * master key and checked against every one. Pure: no I/O.
 */

const PURPOSE = "accounting-oauth-state";
const TOKEN = /^vx1\.([A-Za-z0-9_-]{8,1500})\.([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A connection must come back from the provider within ten minutes. */
export const STATE_TTL_MS = 10 * 60_000;

export interface Consent {
  version: string;
  /** ISO time the person ticked I agree. */
  at: string;
}

export interface ConnectState {
  provider: ProviderId;
  org: string;
  user: string;
  nonce: string;
  /** Null when the state carries none: the callback then refuses. */
  consent: Consent | null;
}

function mac(master: MasterKey, body: string): Buffer {
  const key = Buffer.from(crypto.hkdfSync("sha256", master.key, Buffer.alloc(0), `vestiarion/${PURPOSE}/v1`, 32));
  return crypto.createHmac("sha256", key).update(`${PURPOSE}.${body}`, "utf8").digest();
}

export function connectState(state: ConnectState, keys: MasterKey[], nowMs: number = Date.now()): string {
  const current = keys[0];
  if (!current) throw new Error("no master key to sign with");
  const payload = {
    p: state.provider,
    o: state.org,
    u: state.user,
    n: state.nonce,
    ...(state.consent ? { c: { v: state.consent.version, a: state.consent.at } } : {}),
    x: nowMs + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `vx1.${body}.${mac(current, body).toString("base64url")}`;
}

export function readConnectState(token: string, keys: MasterKey[], nowMs: number = Date.now()): ConnectState | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, body, signature] = match;
  const given = Buffer.from(signature, "base64url");
  const signed = keys.some((key) => {
    const expected = mac(key, body);
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
  const { p, o, u, n, c, x } = payload as Record<string, unknown>;
  if (typeof x !== "number" || x <= nowMs) return null;
  if (typeof p !== "string" || !(PROVIDERS as readonly string[]).includes(p)) return null;
  if (typeof o !== "string" || !UUID.test(o) || typeof u !== "string" || !UUID.test(u)) return null;
  if (typeof n !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(n)) return null;
  let consent: Consent | null = null;
  if (typeof c === "object" && c !== null) {
    const { v, a } = c as Record<string, unknown>;
    if (typeof v === "string" && v.length <= 40 && typeof a === "string" && !Number.isNaN(Date.parse(a))) consent = { version: v, at: a };
  }
  return { provider: p as ProviderId, org: o, user: u, nonce: n, consent };
}

/** A random nonce for the browser's cookie: 32 bytes in base64url. */
export function newNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}
