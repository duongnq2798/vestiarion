import { NextResponse, type NextRequest } from "next/server";
import { AFTER_SIGN_IN_COOKIE, afterSignInTarget } from "@/lib/auth/after-sign-in";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Exchanges the one-time code from a magic link or OAuth redirect for a
 * session. The exchange needs the PKCE verifier cookie set when the link was
 * requested, so a link opened in another browser fails here — and the login
 * page says exactly that.
 *
 * Google sign-in keeps `next` through this callback, so the `vx_after_sign_in`
 * cookie (see `src/lib/auth/after-sign-in.ts`) rarely matters here — but the
 * same explicit-search-param-wins rule applies, for the request that somehow
 * arrives without one. Single-use: deleted on both the success and the
 * failure response.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const target = afterSignInTarget(
    request.nextUrl.searchParams.get("next"),
    request.cookies.get(AFTER_SIGN_IN_COOKIE)?.value
  );

  let response: NextResponse;
  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      response = NextResponse.redirect(new URL(target, request.url));
    } else {
      console.error("sign-in code exchange failed", error.message);
      response = NextResponse.redirect(new URL(`/login?error=link&next=${encodeURIComponent(target)}`, request.url));
    }
  } else {
    response = NextResponse.redirect(new URL(`/login?error=link&next=${encodeURIComponent(target)}`, request.url));
  }

  response.cookies.delete(AFTER_SIGN_IN_COOKIE);
  return response;
}
