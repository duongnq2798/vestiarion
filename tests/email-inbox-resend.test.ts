import { describe, expect, it } from "vitest";
import { downloadAttachment, emailText, fetchReceivedEmail } from "@/lib/email-inbox/resend";

/**
 * The two calls the inbox makes to Resend (email invoices design E5): a received email, with its sender, subject, text,
 * SPF/DKIM/DMARC and its attachments' metadata; and one attachment, through the expiring download link Resend gives,
 * only on Resend's own hosts and within the size limit. Each has a deadline; a failure is reported, never thrown, and
 * the key never leaves for anywhere but Resend's API.
 */

const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ATTACHMENT_ID = "3b1d0df1-4223-5839-087f-54eedd27b419";
/** An attachment's link as Resend gives it: signed, expiring, on cdn.resend.app. */
const DOWNLOAD = `https://cdn.resend.app/receiving/${EMAIL_ID}/attachments/${ATTACHMENT_ID}?response-content-disposition=attachment&Expires=1791055056&Key-Pair-Id=K1EXAMPLE&Signature=sig`;

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    sent.push(call);
    return reply(call);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EMAIL = {
  object: "email",
  id: EMAIL_ID,
  to: ["invoices-abcdefghij23@abc123.resend.app"],
  from: "Test Freelancer A <billing@freelancer.example>",
  created_at: "2026-10-03T15:00:00.000Z",
  subject: "Invoice TFA-2026-1003",
  html: "<p>Please find the invoice attached.</p>",
  text: "Please find the invoice attached.",
  authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
  attachments: [
    { id: "2a0c9ce0-3112-4728-976e-47ddcd16a318", filename: "logo.png", content_type: "image/png", content_disposition: "inline", size: 4096 },
    { id: ATTACHMENT_ID, filename: "Invoice-TFA-2026-1003.pdf", content_type: "application/pdf", content_disposition: null, size: 62263 },
  ],
};

describe("fetchReceivedEmail", () => {
  it("reads the email from Resend's receiving API with the key, and keeps what the inbox needs", async () => {
    const { sent, fetchImpl } = fakeFetch(() => json(EMAIL));
    const email = await fetchReceivedEmail("re_key", EMAIL_ID, fetchImpl);

    expect(sent[0].url).toBe(`https://api.resend.com/emails/receiving/${EMAIL_ID}`);
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe("Bearer re_key");
    expect(email).toEqual({
      id: EMAIL_ID,
      from: "Test Freelancer A <billing@freelancer.example>",
      to: ["invoices-abcdefghij23@abc123.resend.app"],
      subject: "Invoice TFA-2026-1003",
      text: "Please find the invoice attached.",
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
      attachments: [
        { id: "2a0c9ce0-3112-4728-976e-47ddcd16a318", filename: "logo.png", contentType: "image/png", size: 4096 },
        { id: ATTACHMENT_ID, filename: "Invoice-TFA-2026-1003.pdf", contentType: "application/pdf", size: 62263 },
      ],
    });
  });

  it("asks nothing for an id that is not one of Resend's, and reports a refusal or an outage as nothing", async () => {
    const quiet = fakeFetch(() => json(EMAIL));
    expect(await fetchReceivedEmail("re_key", "../../domains", quiet.fetchImpl)).toBeNull();
    expect(quiet.sent).toHaveLength(0);
    expect(await fetchReceivedEmail("re_key", EMAIL_ID, fakeFetch(() => json({ message: "not found" }, 404)).fetchImpl)).toBeNull();
    expect(await fetchReceivedEmail("re_key", EMAIL_ID, fakeFetch(() => Promise.reject(new Error("socket hang up"))).fetchImpl)).toBeNull();
  });
});

describe("emailText", () => {
  it("is the plain text when there is some, else the HTML without its tags", () => {
    expect(emailText({ text: "Amount due: 0.75 USDC", html: "<p>other</p>" })).toBe("Amount due: 0.75 USDC");
    expect(emailText({ text: null, html: "<div>Amount due:&nbsp;<b>0.75 USDC</b></div><p>Due 2026-10-10 &amp; thanks</p>" })).toBe(
      "Amount due: 0.75 USDC\nDue 2026-10-10 & thanks"
    );
    expect(emailText({ text: null, html: `data:text/html;base64,${Buffer.from("<p>Total 2.00 USDC</p>").toString("base64")}` })).toBe("Total 2.00 USDC");
    expect(emailText({ text: null, html: null })).toBe("");
  });
});

describe("downloadAttachment", () => {
  const meta = { object: "attachment", id: ATTACHMENT_ID, filename: "Invoice-TFA-2026-1003.pdf", size: 8, content_type: "application/pdf", download_url: DOWNLOAD, expires_at: "2026-10-03T16:00:00.000Z" };
  const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);

  it("asks Resend for the attachment's link with the key, then fetches it without the key", async () => {
    const { sent, fetchImpl } = fakeFetch((call) =>
      call.url.startsWith("https://api.resend.com/") ? json(meta) : new Response(new Blob([PDF]), { status: 200, headers: { "content-type": "application/pdf" } })
    );
    const result = await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 4_000_000, fetchImpl);

    expect(sent.map((call) => call.url)).toEqual([`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${ATTACHMENT_ID}`, DOWNLOAD]);
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe("Bearer re_key");
    expect(new Headers(sent[1].init.headers).get("authorization")).toBeNull();
    expect(result).toEqual({ ok: true, bytes: PDF, contentType: "application/pdf" });
  });

  it("fetches a link on Resend's own domains, resend.app and resend.com, over https", async () => {
    for (const url of [DOWNLOAD, "https://cdn.resend.com/a.pdf"]) {
      const { sent, fetchImpl } = fakeFetch((call) => (call.url.startsWith("https://api.resend.com/") ? json({ ...meta, download_url: url }) : new Response(new Blob([PDF]))));
      expect(await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 4_000_000, fetchImpl)).toMatchObject({ ok: true, bytes: PDF });
      expect(sent.map((call) => call.url)[1]).toBe(url);
    }
  });

  it("fetches a link nowhere else", async () => {
    for (const url of [
      "https://example.com/a.pdf",
      "http://cdn.resend.app/a.pdf",
      "https://cdn.resend.app.example.com/a.pdf",
      "https://cdnresend.app/a.pdf",
      "https://inbound-cdn.resend.com.example.com/a.pdf",
    ]) {
      const { sent, fetchImpl } = fakeFetch(() => json({ ...meta, download_url: url }));
      expect(await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 4_000_000, fetchImpl)).toEqual({ ok: false, reason: "not_resend" });
      expect(sent).toHaveLength(1);
    }
  });

  it("refuses an attachment over the limit, whether Resend says so first or not", async () => {
    const declared = fakeFetch(() => json({ ...meta, size: 5_000_000 }));
    expect(await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 4_000_000, declared.fetchImpl)).toEqual({ ok: false, reason: "too_large" });
    expect(declared.sent).toHaveLength(1);
    const actual = fakeFetch((call) => (call.url.startsWith("https://api.resend.com/") ? json(meta) : new Response(new Blob([new Uint8Array(20)]))));
    expect(await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 10, actual.fetchImpl)).toEqual({ ok: false, reason: "too_large" });
  });

  it("reports a missing attachment or an outage, without throwing", async () => {
    expect(await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 4_000_000, fakeFetch(() => json({}, 404)).fetchImpl)).toEqual({ ok: false, reason: "not_found" });
    expect(await downloadAttachment("re_key", EMAIL_ID, ATTACHMENT_ID, 4_000_000, fakeFetch(() => Promise.reject(new Error("down"))).fetchImpl)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
