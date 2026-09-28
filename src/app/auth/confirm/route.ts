import { NextResponse, type NextRequest } from "next/server";
import { AFTER_SIGN_IN_COOKIE, afterSignInTarget } from "@/lib/auth/after-sign-in";
import { parseConfirmParams } from "@/lib/auth/confirm";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Where an email sign-in link lands: /auth/confirm?token_hash=…&type=email.
 *
 * The Supabase email templates (supabase/templates/) build this link from
 * {{ .SiteURL }} and {{ .TokenHash }}, so the email links to this site rather
 * than to <project>.supabase.co. `/auth/callback` stays for Google sign-in and
 * for links sent before the templates changed.
 *
 * The templates also drop `next`, so the destination falls back to the
 * `vx_after_sign_in` cookie the login action set (see
 * `src/lib/auth/after-sign-in.ts`) — the same explicit-search-param-wins rule
 * as `/auth/callback`. The cookie is single-use: it is deleted here whether
 * verification succeeds or fails.
 */
export async function GET(request: NextRequest) {
  const params = parseConfirmParams(request.nextUrl.searchParams);
  const target = afterSignInTarget(
    request.nextUrl.searchParams.get("next"),
    request.cookies.get(AFTER_SIGN_IN_COOKIE)?.value
  );

  let response: NextResponse;
  if (params) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ type: params.type, token_hash: params.tokenHash });
    if (!error) {
      response = NextResponse.redirect(new URL(target, request.url));
    } else {
      console.error("sign-in token verification failed", error.status, error.code, error.message);
      response = NextResponse.redirect(new URL("/login?error=expired", request.url));
    }
  } else {
    response = NextResponse.redirect(new URL("/login?error=expired", request.url));
  }

  response.cookies.delete(AFTER_SIGN_IN_COOKIE);
  return response;
}
