import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { codeOfAddress, inboxAddress, inboxSettingsFromEnv } from "@/lib/email-inbox/settings";
import { verifySvix } from "@/lib/email-inbox/verify";

/**
 * Invoices by email (docs/superpowers/specs/2026-10-03-email-invoices-design.md E1–E3): on only when the inbound
 * domain, the webhook's signing secret and a key are set; an address names its workspace by a 12-character code at the
 * inbound domain alone; and a webhook is believed only when Resend's Svix signature over the raw body checks out, within
 * five minutes.
 */

const KEY = crypto.randomBytes(24);
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = Date.UTC(2026, 9, 3, 16, 0, 0);
const AT = String(Math.floor(NOW / 1000));
const BODY = JSON.stringify({ type: "email.received", data: { email_id: "re-1" } });
const sign = (id: string, at: string, body: string, key: Buffer = KEY) =>
  `v1,${crypto.createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64")}`;

describe("inboxSettingsFromEnv", () => {
  const env = { INBOUND_EMAIL_DOMAIN: "Abc123.resend.app", RESEND_INBOUND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_send" };

  it("is on with the domain, the signing secret and a key, the receiving key first", () => {
    expect(inboxSettingsFromEnv(env)).toEqual({ domain: "abc123.resend.app", webhookSecret: SECRET, apiKey: "re_send" });
    expect(inboxSettingsFromEnv({ ...env, RESEND_RECEIVING_API_KEY: "re_full" })?.apiKey).toBe("re_full");
  });

  it("is off without any of the three, or with a domain or secret that is not one", () => {
    for (const missing of ["INBOUND_EMAIL_DOMAIN", "RESEND_INBOUND_WEBHOOK_SECRET", "RESEND_API_KEY"] as const) {
      expect(inboxSettingsFromEnv({ ...env, [missing]: undefined })).toBeNull();
    }
    expect(inboxSettingsFromEnv({ ...env, INBOUND_EMAIL_DOMAIN: "not a domain" })).toBeNull();
    expect(inboxSettingsFromEnv({ ...env, RESEND_INBOUND_WEBHOOK_SECRET: "secret" })).toBeNull();
  });
});

describe("addresses", () => {
  const DOMAIN = "abc123.resend.app";

  it("names a workspace's address by its code at the inbound domain", () => {
    expect(inboxAddress("abcdefghij23", DOMAIN)).toBe("invoices-abcdefghij23@abc123.resend.app");
  });

  it("reads the code back from an address, however it is written", () => {
    expect(codeOfAddress("invoices-abcdefghij23@abc123.resend.app", DOMAIN)).toBe("abcdefghij23");
    expect(codeOfAddress("Acme AP <Invoices-ABCDEFGHIJ23@ABC123.resend.app>", DOMAIN)).toBe("abcdefghij23");
    expect(codeOfAddress("invoices-abcdefghij23+oct@abc123.resend.app", DOMAIN)).toBe("abcdefghij23");
  });

  it("reads no code from another domain, a lookalike, or another local part", () => {
    for (const address of [
      "invoices-abcdefghij23@example.com",
      "invoices-abcdefghij23@abc123.resend.app.example.com",
      "invoices-abcdefghij23@evil-abc123.resend.app",
      "billing@abc123.resend.app",
      "invoices-short@abc123.resend.app",
      "invoices-abcdefghij01@abc123.resend.app",
    ]) {
      expect(codeOfAddress(address, DOMAIN), address).toBeNull();
    }
  });
});

describe("verifySvix", () => {
  const request = (fields: Partial<{ id: string | null; timestamp: string | null; signature: string | null; body: string }> = {}) => ({
    id: "msg_1",
    timestamp: AT,
    signature: sign("msg_1", AT, BODY),
    body: BODY,
    ...fields,
  });

  it("believes a request signed with the secret, over the raw body", () => {
    expect(verifySvix(request(), SECRET, NOW)).toBe(true);
  });

  it("believes any one of several signatures, as Svix sends during a secret's rotation", () => {
    const other = sign("msg_1", AT, BODY, crypto.randomBytes(24));
    expect(verifySvix(request({ signature: `${other} ${sign("msg_1", AT, BODY)}` }), SECRET, NOW)).toBe(true);
  });

  it("refuses a changed body, another id, another secret, or a missing header", () => {
    expect(verifySvix(request({ body: `${BODY} ` }), SECRET, NOW)).toBe(false);
    expect(verifySvix(request({ id: "msg_2" }), SECRET, NOW)).toBe(false);
    expect(verifySvix(request({ signature: sign("msg_1", AT, BODY, crypto.randomBytes(24)) }), SECRET, NOW)).toBe(false);
    expect(verifySvix(request({ signature: `v2,${sign("msg_1", AT, BODY).slice(3)}` }), SECRET, NOW)).toBe(false);
    for (const missing of ["id", "timestamp", "signature"] as const) expect(verifySvix(request({ [missing]: null }), SECRET, NOW)).toBe(false);
  });

  it("refuses a request more than five minutes old, or from the future", () => {
    expect(verifySvix(request(), SECRET, NOW + 301_000)).toBe(false);
    expect(verifySvix(request(), SECRET, NOW - 301_000)).toBe(false);
    expect(verifySvix(request(), SECRET, NOW + 299_000)).toBe(true);
  });
});
