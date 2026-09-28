import { describe, expect, it } from "vitest";
import { invitationEmail } from "@/lib/email/invitation";
import { emailSettingsFromEnv, sendEmail } from "@/lib/email/send";

describe("emailSettingsFromEnv", () => {
  it("is null without RESEND_API_KEY", () => {
    expect(emailSettingsFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it("defaults the sender to no-reply@vestiarion.xyz", () => {
    expect(emailSettingsFromEnv({ RESEND_API_KEY: "re_test" } as unknown as NodeJS.ProcessEnv))
      .toEqual({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
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

  it("reports a refused send without throwing", async () => {
    const result = await sendEmail(message, { apiKey: "re_test", from: "x <no-reply@vestiarion.xyz>" },
      async () => new Response(JSON.stringify({ message: "bad" }), { status: 422 }));
    expect(result).toEqual({ sent: false, reason: "status 422" });
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
    }
  });

  it("renders a workspace name as text, never as markup", () => {
    const email = invitationEmail({ ...base, orgName: `<img src=x onerror="alert(1)">&` });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  });
});
