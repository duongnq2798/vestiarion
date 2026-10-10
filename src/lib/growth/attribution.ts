/**
 * A workspace's first touch: which outreach or page brought the person who opened it. Pure, shared by the browser,
 * which writes the cookie (src/components/analytics/FirstTouch.tsx), and the onboarding action, which reads it when a
 * workspace is created and records it once (record_org_attribution, migration 0099).
 *
 * The cookie `vx_ft` is first-party, set only when the address carries a campaign tag (utm_source, utm_medium,
 * utm_campaign, utm_content, utm_term or ref) and no first touch is kept yet, for 90 days. It holds those tags, each
 * cut to 100 characters of `[A-Za-z0-9._~-]` (a space becomes a hyphen, anything else is dropped), the path the visit
 * landed on without its query, the host of the site that linked to it, and when. Never an email, a name or free text:
 * nothing outside that alphabet survives, and a tag with an `@` in it is dropped whole.
 *
 * Its value is `key=value` pairs joined by `&`, every value already in a cookie-safe alphabet, so it needs no encoding
 * and stays under 1 KB.
 */

export const FIRST_TOUCH_COOKIE = "vx_ft";
export const FIRST_TOUCH_DAYS = 90;
export const FIRST_TOUCH_MAX_AGE_SECONDS = FIRST_TOUCH_DAYS * 24 * 60 * 60;
export const TAG_MAX = 100;
export const COOKIE_MAX_BYTES = 1024;

/** The query parameters that make a visit a campaign's, with the short key each takes in the cookie. */
export const TAG_KEYS = { utm_source: "s", utm_medium: "m", utm_campaign: "c", utm_content: "n", utm_term: "t", ref: "r" } as const;
export type TagName = keyof typeof TAG_KEYS;
const TAG_NAMES = Object.keys(TAG_KEYS) as TagName[];

/** What record_org_attribution receives: snake_case, every field optional. */
export interface FirstTouch {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  ref?: string;
  landing_path?: string;
  referrer_host?: string;
  first_seen_at?: string;
}

/**
 * A tag as the cookie may hold it: trimmed, spaces to hyphens, only `[A-Za-z0-9._~-]`, at most 100; empty as null. A
 * value with an `@` in it is dropped whole, so an email address put in a tag never survives even with its `@` removed.
 */
export function sanitizeTag(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.includes("@")) return null;
  const clean = value.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._~-]/g, "").slice(0, TAG_MAX);
  return clean === "" ? null : clean;
}

/** A path as the cookie may hold it: the same alphabet plus `/`, at most 100, always starting with `/`. */
export function sanitizePath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const clean = value.split(/[?#]/)[0].replace(/[^A-Za-z0-9._~/-]/g, "").slice(0, TAG_MAX);
  return clean.startsWith("/") ? clean : null;
}

/** A host as the cookie may hold it: lower case, letters, digits, dots and hyphens, at most 100. */
export function sanitizeHost(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase();
  return /^[a-z0-9.-]{1,100}$/.test(clean) && clean.includes(".") ? clean : null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * The first touch a visit makes, or null when its address carries no campaign tag that survives sanitizing.
 * `referrer` is the full referrer; only its host is kept, and only when it is another site's.
 */
export function firstTouchFrom(location: { search: string; pathname: string; host: string }, referrer: string, now: Date): FirstTouch | null {
  const params = new URLSearchParams(location.search);
  const touch: FirstTouch = {};
  for (const name of TAG_NAMES) {
    const value = sanitizeTag(params.get(name));
    if (value) touch[name] = value;
  }
  if (!TAG_NAMES.some((name) => touch[name])) return null;
  const path = sanitizePath(location.pathname);
  if (path) touch.landing_path = path;
  let host: string | null = null;
  try {
    const url = new URL(referrer);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.host !== location.host) host = sanitizeHost(url.hostname);
  } catch {
    // No referrer, or not an address.
  }
  if (host) touch.referrer_host = host;
  touch.first_seen_at = now.toISOString();
  return touch;
}

/** The cookie's value for a first touch. */
export function serializeFirstTouch(touch: FirstTouch): string {
  const pairs: string[] = ["v=1"];
  for (const name of TAG_NAMES) if (touch[name]) pairs.push(`${TAG_KEYS[name]}=${touch[name]}`);
  if (touch.landing_path) pairs.push(`p=${touch.landing_path}`);
  if (touch.referrer_host) pairs.push(`h=${touch.referrer_host}`);
  if (touch.first_seen_at) pairs.push(`at=${touch.first_seen_at}`);
  return pairs.join("&");
}

/**
 * Reads the cookie back on the server, sanitizing every value again, since a browser can send anything: null when it
 * is absent, unreadable, too long, or carries no campaign tag.
 */
export function parseFirstTouch(raw: string | null | undefined): FirstTouch | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > COOKIE_MAX_BYTES) return null;
  let value = raw;
  // A value a framework percent-encoded on the way is read back the same.
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  const fields = new Map<string, string>();
  for (const pair of value.split("&")) {
    const at = pair.indexOf("=");
    if (at > 0 && !fields.has(pair.slice(0, at))) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  if (fields.get("v") !== "1") return null;
  const touch: FirstTouch = {};
  for (const name of TAG_NAMES) {
    const tag = sanitizeTag(fields.get(TAG_KEYS[name]));
    if (tag) touch[name] = tag;
  }
  if (!TAG_NAMES.some((name) => touch[name])) return null;
  const path = sanitizePath(fields.get("p"));
  if (path) touch.landing_path = path;
  const host = sanitizeHost(fields.get("h"));
  if (host) touch.referrer_host = host;
  const seen = fields.get("at");
  if (seen && ISO_INSTANT.test(seen) && !Number.isNaN(Date.parse(seen))) touch.first_seen_at = seen;
  return touch;
}

/** The whole `Set-Cookie`-style string the browser writes with `document.cookie`. */
export function firstTouchCookie(touch: FirstTouch, secure: boolean): string {
  return [`${FIRST_TOUCH_COOKIE}=${serializeFirstTouch(touch)}`, `Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}`, "Path=/", "SameSite=Lax", ...(secure ? ["Secure"] : [])].join("; ");
}

/** Whether a `document.cookie` string already holds a first touch. */
export function hasFirstTouch(cookies: string): boolean {
  return cookies.split(";").some((cookie) => cookie.trim().startsWith(`${FIRST_TOUCH_COOKIE}=`));
}
