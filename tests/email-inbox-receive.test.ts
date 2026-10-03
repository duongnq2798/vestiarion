import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/email/inbound/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { handleInbound } from "@/lib/email-inbox/receive";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * An email at a workspace's address (email invoices design E3–E6, E9, E10): believed only with Resend's signature,
 * stored at once and answered, then read after the response the way From a document reads one, into a draft a person
 * adds, never added by itself; a redelivery is kept once; what cannot be read says why rather than vanishing; and the
 * workspace's Slack channel is told.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e21";
const ROW_ID = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e22";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ATTACHMENT_ID = "3b1d0df1-4223-5839-087f-54eedd27b419";
/** The attachment's link as Resend gives it: signed, expiring, on cdn.resend.app. */
const DOWNLOAD = `https://cdn.resend.app/receiving/${EMAIL_ID}/attachments/${ATTACHMENT_ID}?Expires=1791055056&Key-Pair-Id=K1EXAMPLE&Signature=sig`;
const DOMAIN = "abc123.resend.app";
const ADDRESS = `invoices-abcdefghij23@${DOMAIN}`;
const KEY = crypto.randomBytes(24);
const SETTINGS = { domain: DOMAIN, webhookSecret: `whsec_${KEY.toString("base64")}`, apiKey: "re_full" };
const COUNTERPARTIES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting", role: "vendor", address: null, notice_email: "billing@northwind.example" },
];
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const PDF = readFileSync(path.join(__dirname, "fixtures", "invoice-document", "northwind-inv-2207.pdf"));
const HOOK = "https://hooks.slack.com/services/T0TEAM/B0HOOK/abcdefghijklmnopqrstuvwx";
/** The handler's clock, which the signature's timestamp must be within five minutes of. */
const NOW = new Date("2026-10-03T16:00:00Z");

const email = (fields: Record<string, unknown> = {}) => ({
  object: "email",
  id: EMAIL_ID,
  to: [ADDRESS],
  from: "Northwind Billing <billing@northwind.example>",
  subject: "Invoice INV-2207",
  text: "Please find the invoice attached.",
  html: null,
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  attachments: [{ id: ATTACHMENT_ID, filename: "northwind-inv-2207.pdf", content_type: "application/pdf", size: PDF.length }],
  ...fields,
});

function signedEvent(payload: unknown, key: Buffer = KEY): Request {
  const body = JSON.stringify(payload);
  const id = `msg_${crypto.randomBytes(6).toString("hex")}`;
  const at = String(Math.floor(NOW.getTime() / 1000));
  const signature = `v1,${crypto.createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64")}`;
  return new Request("https://www.vestiarion.xyz/api/email/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": at, "svix-signature": signature },
    body,
  });
}

const received = (to: string[] = [ADDRESS]) => ({
  type: "email.received",
  created_at: "2026-10-03T16:00:00.000Z",
  data: { email_id: EMAIL_ID, from: "Northwind Billing <billing@northwind.example>", to, cc: [], received_for: [], subject: "Invoice INV-2207", attachments: [] },
});

let stored: boolean;
let resendEmail: unknown;
let slackInstalled: boolean;
let downloadUrl: string;

beforeEach(() => {
  stored = false;
  resendEmail = email();
  slackInstalled = false;
  downloadUrl = DOWNLOAD;
});

function world() {
  const keys = parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { slug: "northstar", name: "Northstar", mode: "live" }) };
    if (sent.path === "/rest/v1/invoice_inboxes") {
      return { body: sent.params.get("code") === "eq.abcdefghij23" ? [{ id: "inbox-1", org_id: ORG, code: "abcdefghij23", created_at: "2026-10-03T08:00:00Z" }] : [] };
    }
    if (sent.path === "/rest/v1/inbox_emails" && sent.method === "POST") {
      if (stored) return { body: [] };
      stored = true;
      return { body: [{ id: ROW_ID }] };
    }
    if (sent.path === "/rest/v1/counterparties") {
      const id = sent.params.get("id");
      return { body: id ? COUNTERPARTIES.filter((row) => id === `eq.${row.id}`) : COUNTERPARTIES };
    }
    if (sent.path === "/rest/v1/slack_installs") {
      if (!slackInstalled) return { body: [] };
      const envelope = encryptSecret(HOOK, { orgId: ORG, column: "slack_installs.webhook_url_enc" }, keys);
      return {
        body: [{ id: "inst-1", org_id: ORG, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0FIN", channel_name: "#finance", installed_at: "2026-10-03T08:00:00Z", notified_seq: 1, decisions_limit_usdc: null, scopes: [], team_name: null, installed_by: null, bot_user_id: null, bot_token_enc: envelope, webhook_url_enc: envelope }],
      };
    }
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === `https://api.resend.com/emails/receiving/${EMAIL_ID}`) {
      return resendEmail ? Response.json(resendEmail) : new Response("not found", { status: 404 });
    }
    if (url === `https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${ATTACHMENT_ID}`) {
      return Response.json({ id: ATTACHMENT_ID, filename: "northwind-inv-2207.pdf", size: PDF.length, content_type: "application/pdf", download_url: downloadUrl });
    }
    if (url === DOWNLOAD) return new Response(new Blob([new Uint8Array(PDF)]), { headers: { "content-type": "application/pdf" } });
    if (url.startsWith("https://hooks.slack.com/")) return new Response("ok");
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const deferred: Array<Promise<void>> = [];
  const handle = async (request: Request) => {
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handleInbound(request, {
        settings: SETTINGS,
        origin: "https://www.vestiarion.xyz",
        fetchImpl,
        defer: (work) => void deferred.push(runWith({ config, db: fake.client, fetch: fake.fetch }, work)),
        now: () => NOW,
      })
    );
    await Promise.all(deferred);
    return response;
  };
  return { fake, calls, handle };
}

const patches = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/inbox_emails" && sent.method === "PATCH").map((sent) => sent.body as Record<string, unknown>);
const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> });

describe("the inbound route", () => {
  it("is not there when invoices by email are not configured", async () => {
    expect((await POST(signedEvent(received()))).status).toBe(404);
  });
});

describe("handleInbound", () => {
  it("answers 401 to a request Resend did not sign, and stores nothing", async () => {
    const { fake, handle } = world();
    expect((await handle(signedEvent(received(), crypto.randomBytes(24)))).status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it("acknowledges another event, and an email to no inbox, storing nothing", async () => {
    const { fake, calls, handle } = world();
    expect((await handle(signedEvent({ type: "email.delivered", data: {} }))).status).toBe(200);
    expect((await handle(signedEvent(received(["billing@abc123.resend.app", "invoices-zzzzzzzzzz77@abc123.resend.app"])))).status).toBe(200);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/inbox_emails")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stores the email at once, then reads its PDF into a draft a person adds, adding nothing itself", async () => {
    const { fake, calls, handle } = world();
    const response = await handle(signedEvent(received()));

    expect(response.status).toBe(200);
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/inbox_emails" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ org_id: ORG, resend_email_id: EMAIL_ID, from_address: "Northwind Billing <billing@northwind.example>", subject: "Invoice INV-2207", status: "received" });
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.resend.com/emails/receiving/${EMAIL_ID}`,
      `https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${ATTACHMENT_ID}`,
      DOWNLOAD,
    ]);
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({
      status: "ready",
      reasons: [],
      draft: { draft: { counterpartyId: COUNTERPARTIES[0].id, amount: "200.00", currency: "USDC" }, document: { kind: "pdf" } },
      read: { counterpartyName: "Northwind Hosting", amount: "200.00", currency: "USDC", knownSender: true },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });
    const entries = ledger(fake.requests);
    expect(entries.map((entry) => entry.p_action)).toEqual(["invoice_email_received"]);
    expect(entries[0].p_detail).toMatchObject({ inboxEmailId: ROW_ID, from: "bi***@northwind.example", read: "ready", document: { kind: "pdf" } });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST")).toBe(false);
  });

  it("keeps a redelivered email once, and reads it once", async () => {
    stored = true;
    const { calls, handle } = world();
    expect((await handle(signedEvent(received()))).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("reads the email's own text when it carries no invoice file, and says what is missing", async () => {
    resendEmail = email({ attachments: [], text: "INVOICE INV-88 from Quillfeather Studio. Amount due: 75.00 USDC. Due date: 2026-11-01." });
    const { fake, handle } = world();
    await handle(signedEvent(received()));
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({ status: "needs_details", draft: null });
    expect((patch.reasons as string[])[0]).toContain("no counterparty in this workspace matches");
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ read: "needs_details" });
  });

  it("marks an email it could not read, with the reason, rather than losing it", async () => {
    resendEmail = null;
    const { fake, handle } = world();
    await handle(signedEvent(received()));
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({ status: "unreadable" });
    expect((patch.reasons as string[])[0]).toContain("Forward it again");
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ read: "unreadable", document: null });
  });

  it("says why an attachment could not be fetched: to the person in words, and to the log as the reason", async () => {
    downloadUrl = "https://example.com/inv.pdf";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, handle } = world();
    await handle(signedEvent(received()));
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({ status: "unreadable", reasons: ["Its attachment could not be fetched from Resend. Forward it again in a moment."] });
    expect(errors).toHaveBeenCalledWith("email inbox: attachment not fetched", ORG, "not_resend");
    errors.mockRestore();
  });

  it("tells the workspace's Slack channel that an invoice arrived, with a link to it", async () => {
    slackInstalled = true;
    const { calls, handle } = world();
    await handle(signedEvent(received()));
    const post = calls.find((call) => call.url === HOOK);
    expect(post).toBeDefined();
    const message = JSON.stringify(JSON.parse(String(post?.init.body)));
    expect(message).toContain("New invoice by email");
    expect(message).toContain("Northwind Hosting");
    expect(message).toContain("https://www.vestiarion.xyz/o/northstar/invoices#email-inbox");
  });
});
