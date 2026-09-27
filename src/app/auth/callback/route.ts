import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/routes";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Exchanges the one-time code from a magic link or OAuth redirect for a
 * session. The exchange needs the PKCE verifier cookie set when the link was
 * requested, so a link opened in another browser fails here — and the login
 * page says exactly that.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.url));
    console.error("sign-in code exchange failed", error.message);
  }
  return NextResponse.redirect(new URL(`/login?error=link&next=${encodeURIComponent(next)}`, request.url));
}
