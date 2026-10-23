import { afterEach, describe, expect, it, vi } from "vitest";
import { invitationEmail } from "@/lib/email/invitation";
import { emailSettingsFromEnv, SEND_TIMEOUT_MS, sendEmail } from "@/lib/email/send";

describe("emailSettingsFromEnv", () => {
  afterEach(() => vi.restoreAllMocks());

  const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

  it("is null without RESEND_API_KEY", () => {
    expect(emailSettingsFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it("defaults the sender to no-reply@vestiarion.xyz", () => {
    expect(emailSettingsFromEnv({ RESEND_API_KEY: "re_test" } as unknown as NodeJS.ProcessEnv))
      .toEqual({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
  });

  it.each([
    "Vestiarion Team <team@vestiarion.xyz>",
    "team@vestiarion.xyz",
    "Vestiarion <No-Reply@Vestiarion.XYZ>",
  ])("accepts an EMAIL_FROM on vestiarion.xyz: %s", (from) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(emailSettingsFromEnv(env({ RESEND_API_KEY: "re_test", EMAIL_FROM: from }))).toEqual({ apiKey: "re_test", from });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "Vestiarion <no-reply@example.com>",
    "someone@gmail.com",
    "no-reply@vestiarion.xyz.example.com",
    "Vestiarion <no-reply@notvestiarion.xyz>",
    "no-reply@vestiarion.xyz <x@evil.test>",
  ])("ignores an EMAIL_FROM on any other domain, warning without the value: %s", (from) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(emailSettingsFromEnv(env({ RESEND_API_KEY: "re_test", EMAIL_FROM: from })))
      .toEqual({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
    expect(warn).toHaveBeenCalledWith("EMAIL_FROM ignored: only @vestiarion.xyz addresses may send");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(from);
  });
});

describe("sendEmail", () => {
  const message = { to: "a@example.com", subject: "S", html: "<p>H</p>", text: "H" };

  it("does not call the network when email is not configured", async () => {
    let called = false;
    const result = await sendEmail(message, null, async () => { called = true; return new Response("{}"); });
    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(called).toBe(false);
  });

  it("posts to Resend with the key as a bearer and returns the message id", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const result = await sendEmail(message, { apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" }, async (url, init) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    });
    expect(result).toEqual({ sent: true, id: "msg_1" });
    expect(seen?.url).toBe("https://api.resend.com/emails");
    expect(new Headers(seen?.init?.headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      from: "Vestiarion <no-reply@vestiarion.xyz>", to: ["a@example.com"], subject: "S", html: "<p>H</p>", text: "H",
    });
  });

  it("sends its idempotency key, and says when Resend refuses it because the key went with another email (notifications I11)", async () => {
    const key = "a".repeat(64);
    let headers: Headers | undefined;
    const used = await sendEmail({ ...message, idempotencyKey: key }, { apiKey: "re_test", from: "x <no-reply@vestiarion.xyz>" }, async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ name: "invalid_idempotent_request", message: "Same idempotency key used with a different request payload." }), { status: 409 });
    });
    expect(headers?.get("idempotency-key")).toBe(key);
    expect(used).toEqual({ sent: false, reason: "idempotency_key_used" });
    // Another request still in progress under the key is only a failure: the next cycle tries again.
    const busy = await sendEmail({ ...message, idempotencyKey: key }, { apiKey: "re_test", from: "x <no-reply@vestiarion.xyz>" },
      async () => new Response(JSON.stringify({ name: "concurrent_idempotent_requests" }), { status: 409 }));
    expect(busy).toEqual({ sent: false, reason: "status 409" });
  });

  it("sends in a business's name, from Vestiarion's own address, with nothing in the name that could change the header", async () => {
    const fromOf = async (fromName: string, from = "Vestiarion <no-reply@vestiarion.xyz>") => {
      let body: { from?: string } = {};
      await sendEmail({ ...message, fromName }, { apiKey: "re_test", from }, async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
      });
      return body.from;
    };
    expect(await fromOf("Pinecrest Studio")).toBe('"Pinecrest Studio via Vestiarion" <no-reply@vestiarion.xyz>');
    expect(await fromOf("Pinecrest Studio", "no-reply@vestiarion.xyz")).toBe('"Pinecrest Studio via Vestiarion" <no-reply@vestiarion.xyz>');
    expect(await fromOf('Evil" <x@evil.example>\r\nBcc: y@evil.example')).toBe('"Evil x@evil.example Bcc: y@evil.example via Vestiarion" <no-reply@vestiarion.xyz>');
    expect(await fromOf("   ")).toBe("Vestiarion <no-reply@vestiarion.xyz>");
    expect(((await fromOf("A".repeat(200))) ?? "").length).toBeLessThan(120);
  });

  it("reports a refused send without throwing", async () => {
    const result = await sendEmail(message, { apiKey: "re_test", from: "x <no-reply@vestiarion.xyz>" },
      async () => new Response(JSON.stringify({ message: "bad" }), { status: 422 }));
    expect(result).toEqual({ sent: false, reason: "status 422" });
  });

  it(`gives up on a send that has not answered after ${SEND_TIMEOUT_MS / 1000} s, without throwing`, async () => {
    vi.useFakeTimers();
    // Node runs AbortSignal.timeout on its own timer, which fake timers do not
    // reach; this stand-in aborts the same way (a TimeoutError) on the faked clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      let signal: AbortSignal | undefined;
      // A Resend that never answers: the request settles only when its signal aborts.
      const hanging: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason));
        });
      let settled = false;
      const pending = sendEmail(message, { apiKey: "re_test", from: "x <no-reply@vestiarion.xyz>" }, hanging).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
      expect(signal).toBeDefined();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ sent: false, reason: "timeout" });
      expect(timeout).toHaveBeenCalledWith(SEND_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
      timeout.mockRestore();
    }
  });
});

describe("invitationEmail", () => {
  const base = { role: "approver" as const, link: "https://www.vestiarion.xyz/invite/tok", expiresAt: new Date("2026-10-05T12:00:00Z"), origin: "https://www.vestiarion.xyz" };

  it("names the workspace, the role and the link, and says when it expires", () => {
    const email = invitationEmail({ ...base, orgName: "Acme" });
    expect(email.subject).toBe("You're invited to Acme on Vestiarion");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("Acme");
      expect(part).toContain("approver");
      expect(part).toContain("https://www.vestiarion.xyz/invite/tok");
      expect(part).toContain("2026-10-05");
      expect(part).not.toContain("as a ");
    }
    expect(email.text).toContain("on Vestiarion with the approver role.");
    expect(email.html).toContain(`with the <strong style="color:#18211c;">approver</strong> role`);
  });

  it("renders a workspace name as text, never as markup", () => {
    const email = invitationEmail({ ...base, orgName: `<img src=x onerror="alert(1)">&` });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  });
});
