import { beforeEach, describe, expect, it, vi } from "vitest";
import { AFTER_SIGN_IN_COOKIE } from "@/lib/auth/after-sign-in";

/**
 * The login actions' own cookie write: `signInWithEmail` and
 * `signInWithGoogle` remember a non-default destination in
 * `vx_after_sign_in` (see `src/lib/auth/after-sign-in.ts`), so an email
 * sign-in whose Supabase template drops `next` still has somewhere to fall
 * back to. `next/headers` `cookies()` is mocked, the same shape as
 * `tests/invite-action.test.ts` mocks its collaborators.
 */

vi.mock("server-only", () => ({}));

const { setMock, deleteMock } = vi.hoisted(() => ({ setMock: vi.fn(), deleteMock: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: setMock, get: vi.fn(), delete: deleteMock })) }));

const { signInWithOtpMock, signInWithOAuthMock } = vi.hoisted(() => ({
  signInWithOtpMock: vi.fn(),
  signInWithOAuthMock: vi.fn(),
}));
vi.mock("@/lib/auth/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { signInWithOtp: signInWithOtpMock, signInWithOAuth: signInWithOAuthMock },
  })),
}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { signInWithEmail, signInWithGoogle } = await import("@/app/login/actions");

beforeEach(() => {
  vi.clearAllMocks();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("signInWithEmail — remembering the destination", () => {
  it("sets the cookie to a non-default next after a successful send", async () => {
    signInWithOtpMock.mockResolvedValueOnce({ error: null });

    const result = await signInWithEmail(
      { ok: false, message: "" },
      form({ email: "person@example.com", next: "/invite/abc123" })
    );

    expect(result.ok).toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      AFTER_SIGN_IN_COOKIE,
      "/invite/abc123",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 3600 })
    );
  });

  it("deletes any existing cookie instead of setting one when next is the default or missing", async () => {
    signInWithOtpMock.mockResolvedValueOnce({ error: null });

    await signInWithEmail({ ok: false, message: "" }, form({ email: "person@example.com" }));

    expect(setMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith(AFTER_SIGN_IN_COOKIE);
  });

  it("touches neither the set nor the delete cookie call when the send fails", async () => {
    signInWithOtpMock.mockResolvedValueOnce({ error: { status: 500, code: "unknown", message: "boom" } });

    const result = await signInWithEmail(
      { ok: false, message: "" },
      form({ email: "person@example.com", next: "/invite/abc123" })
    );

    expect(result.ok).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe("signInWithGoogle — remembering the destination", () => {
  it("sets the cookie to a non-default next before redirecting to the provider", async () => {
    signInWithOAuthMock.mockResolvedValueOnce({ data: { url: "https://accounts.google.com/o" }, error: null });

    await expect(
      signInWithGoogle(form({ next: "/invite/abc123" }))
    ).rejects.toThrow("REDIRECT:https://accounts.google.com/o");

    expect(setMock).toHaveBeenCalledWith(
      AFTER_SIGN_IN_COOKIE,
      "/invite/abc123",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 3600 })
    );
  });

  it("deletes any existing cookie instead of setting one when next is the default or missing", async () => {
    signInWithOAuthMock.mockResolvedValueOnce({ data: { url: "https://accounts.google.com/o" }, error: null });

    await expect(signInWithGoogle(form({}))).rejects.toThrow("REDIRECT:https://accounts.google.com/o");

    expect(setMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith(AFTER_SIGN_IN_COOKIE);
  });

  it("touches neither the set nor the delete cookie call when the provider fails to start", async () => {
    signInWithOAuthMock.mockResolvedValueOnce({ data: { url: null }, error: { message: "boom" } });

    await expect(signInWithGoogle(form({ next: "/invite/abc123" }))).rejects.toThrow("REDIRECT:/login?error=google");

    expect(setMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
