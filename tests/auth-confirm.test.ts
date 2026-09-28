import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { AFTER_SIGN_IN_COOKIE } from "@/lib/auth/after-sign-in";
import { parseConfirmParams } from "@/lib/auth/confirm";
import { loginErrorMessage } from "@/lib/auth/messages";

const { verifyOtpMock } = vi.hoisted(() => ({ verifyOtpMock: vi.fn() }));
vi.mock("@/lib/auth/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ auth: { verifyOtp: verifyOtpMock } })),
}));

const { GET } = await import("@/app/auth/confirm/route");

/**
 * The email link now lands on this site — /auth/confirm?token_hash=…&type=email —
 * instead of on <project>.supabase.co, whose mismatch with the sending domain
 * is a phishing signal that sent the first production email to spam.
 */

const PKCE_HASH = "pkce_93cbc7d29d5cb6d4c556e0e4a6f2ce9d8e0b578acec5b29ea1a51172";

function params(query: string) {
  return new URLSearchParams(query);
}

describe("parseConfirmParams", () => {
  it("accepts a sign-in token hash and defaults to onboarding", () => {
    expect(parseConfirmParams(params(`token_hash=${PKCE_HASH}&type=email`))).toEqual({
      tokenHash: PKCE_HASH,
      type: "email",
      next: "/onboarding",
    });
  });

  it.each(["email", "signup", "magiclink"])("accepts the sign-in type %s", (type) => {
    expect(parseConfirmParams(params(`token_hash=${PKCE_HASH}&type=${type}`))?.type).toBe(type);
  });

  it("keeps a same-site next path", () => {
    expect(parseConfirmParams(params(`token_hash=${PKCE_HASH}&type=email&next=%2Fo%2Ffounding%2Faudit`))?.next).toBe(
      "/o/founding/audit"
    );
  });

  it("sends an off-site next to the default, like every other sign-in redirect", () => {
    expect(parseConfirmParams(params(`token_hash=${PKCE_HASH}&type=email&next=%2F%2Fevil.example`))?.next).toBe(
      "/onboarding"
    );
  });

  it.each([
    ["missing token", "type=email"],
    ["empty token", "token_hash=&type=email"],
    ["token with foreign characters", "token_hash=abc%3Cscript%3E123&type=email"],
    ["missing type", `token_hash=${PKCE_HASH}`],
    ["a type this page does not serve", `token_hash=${PKCE_HASH}&type=recovery`],
    ["an unknown type", `token_hash=${PKCE_HASH}&type=admin`],
  ])("refuses %s", (_label, query) => {
    expect(parseConfirmParams(params(query))).toBeNull();
  });
});

describe("GET /auth/confirm — the vx_after_sign_in cookie", () => {
  function request(query: string, cookie?: string): NextRequest {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    return new NextRequest(`https://vestiarion.invalid/auth/confirm?${query}`, { headers });
  }

  it("falls back to the cookie's target when next is absent, and deletes the cookie", async () => {
    verifyOtpMock.mockResolvedValueOnce({ error: null });

    const response = await GET(
      request(`token_hash=${PKCE_HASH}&type=email`, `${AFTER_SIGN_IN_COOKIE}=%2Finvite%2Fabc123`)
    );

    expect(response.headers.get("location")).toBe("https://vestiarion.invalid/invite/abc123");
    expect(response.headers.get("set-cookie")).toContain(AFTER_SIGN_IN_COOKIE);
  });

  it("prefers an explicit next over the cookie", async () => {
    verifyOtpMock.mockResolvedValueOnce({ error: null });

    const response = await GET(
      request(`token_hash=${PKCE_HASH}&type=email&next=%2Fo%2Ffounding%2Faudit`, `${AFTER_SIGN_IN_COOKIE}=%2Finvite%2Fabc123`)
    );

    expect(response.headers.get("location")).toBe("https://vestiarion.invalid/o/founding/audit");
  });

  it("deletes the cookie even when verification fails", async () => {
    verifyOtpMock.mockResolvedValueOnce({ error: { status: 403, code: "otp_expired", message: "expired" } });

    const response = await GET(request(`token_hash=${PKCE_HASH}&type=email`, `${AFTER_SIGN_IN_COOKIE}=%2Finvite%2Fabc123`));

    expect(response.headers.get("location")).toBe("https://vestiarion.invalid/login?error=expired");
    expect(response.headers.get("set-cookie")).toContain(AFTER_SIGN_IN_COOKIE);
  });
});

describe("loginErrorMessage — the email link's own failure", () => {
  it("explains an expired or already-used link without blaming the browser", () => {
    // The token-hash link works in any browser, so the PKCE-era "different
    // browser" explanation would be wrong for it.
    const message = loginErrorMessage("expired");
    expect(message).toMatch(/expired|already used/);
    expect(message).not.toMatch(/browser/);
  });
});
