/**
 * Invoices by email (docs/superpowers/specs/2026-10-03-email-invoices-design.md E1, E2): Resend receives at the
 * inbound domain, Resend's managed `<id>.resend.app` or a subdomain with its MX record, and signs each webhook with the
 * secret it shows. The feature is off unless the domain, that secret and a key that may read received emails are all
 * set; the receiving key is used when there is one, else the sending key.
 */
export interface InboxSettings {
  domain: string;
  webhookSecret: string;
  apiKey: string;
}

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SECRET = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
const LOCAL = /^invoices-([a-z2-7]{12})(?:\+[^@]*)?$/;

export function inboxSettingsFromEnv(env: Record<string, string | undefined> = process.env): InboxSettings | null {
  const domain = env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  const webhookSecret = env.RESEND_INBOUND_WEBHOOK_SECRET?.trim();
  const apiKey = (env.RESEND_RECEIVING_API_KEY?.trim() || env.RESEND_API_KEY?.trim()) ?? "";
  if (!domain || !webhookSecret || !apiKey) return null;
  // Never the values themselves: only which one was not used.
  if (!DOMAIN.test(domain)) {
    console.warn("Invoices by email are off: INBOUND_EMAIL_DOMAIN is not a domain");
    return null;
  }
  if (!SECRET.test(webhookSecret)) {
    console.warn("Invoices by email are off: RESEND_INBOUND_WEBHOOK_SECRET is not a webhook signing secret");
    return null;
  }
  return { domain, webhookSecret, apiKey };
}

/** A workspace's address: its code at the inbound domain. */
export function inboxAddress(code: string, domain: string): string {
  return `invoices-${code}@${domain}`;
}

/**
 * The code an address names, when it is an inbox address at the inbound domain itself: written bare or as
 * `Name <address>`, in any case, with or without a `+tag`. Null for any other domain, a lookalike, or another name.
 */
export function codeOfAddress(address: string, domain: string): string | null {
  const bracketed = /<([^<>]+)>\s*$/.exec(address);
  const bare = (bracketed ? bracketed[1] : address).trim().toLowerCase();
  const at = bare.lastIndexOf("@");
  if (at <= 0 || bare.slice(at + 1) !== domain) return null;
  return LOCAL.exec(bare.slice(0, at))?.[1] ?? null;
}
