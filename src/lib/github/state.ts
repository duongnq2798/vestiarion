import crypto from "node:crypto";
import type { MasterKey } from "../secrets";

/**
 * The state GitHub carries back after an install (docs/superpowers/specs/2026-10-04-github-app-design.md G2): the
 * workspace, the person who started it, and a nonce also kept in their browser's cookie. It is
 * `vx1.<base64url JSON>.<base64url HMAC-SHA256>`, built as the Slack install's state is, with its own key derived by HKDF
 * from the master key, so neither can be read as the other. Signed with the current master key and checked against every
 * one; it expires after ten minutes. Pure: no I/O.
 */

const PURPOSE = "github-install-state";
const TOKEN = /^vx1\.([A-Za-z0-9_-]{8,1500})\.([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An install must come back from GitHub within ten minutes. */
export const STATE_TTL_MS = 10 * 60_000;

function mac(master: MasterKey, body: string): Buffer {
  const key = Buffer.from(crypto.hkdfSync("sha256", master.key, Buffer.alloc(0), `vestiarion/${PURPOSE}/v1`, 32));
  return crypto.createHmac("sha256", key).update(`${PURPOSE}.${body}`, "utf8").digest();
}

/** Who started an install, for which workspace, and the nonce also kept in their browser's cookie. */
export interface InstallState {
  org: string;
  user: string;
  nonce: string;
}

export function installState(state: InstallState, keys: MasterKey[], nowMs: number = Date.now()): string {
  const current = keys[0];
  if (!current) throw new Error("no master key to sign with");
  const body = Buffer.from(JSON.stringify({ o: state.org, u: state.user, n: state.nonce, x: nowMs + STATE_TTL_MS }), "utf8").toString("base64url");
  return `vx1.${body}.${mac(current, body).toString("base64url")}`;
}

export function readInstallState(token: string, keys: MasterKey[], nowMs: number = Date.now()): InstallState | null {
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
  const { o, u, n, x } = payload as Record<string, unknown>;
  if (typeof x !== "number" || x <= nowMs) return null;
  if (typeof o !== "string" || !UUID.test(o) || typeof u !== "string" || !UUID.test(u)) return null;
  if (typeof n !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(n)) return null;
  return { org: o, user: u, nonce: n };
}

/** A random nonce for the install cookie: 32 bytes in base64url. */
export function newNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}
