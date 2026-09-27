import { NextResponse, type NextRequest } from "next/server";
import { parseConfirmParams } from "@/lib/auth/confirm";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Where an email sign-in link lands: /auth/confirm?token_hash=…&type=email.
 *
 * The Supabase email templates (supabase/templates/) build this link from
 * {{ .SiteURL }} and {{ .TokenHash }}, so the email links to this site rather
 * than to <project>.supabase.co. `/auth/callback` stays for Google sign-in and
 * for links sent before the templates changed.
 */
export async function GET(request: NextRequest) {
  const params = parseConfirmParams(request.nextUrl.searchParams);

  if (params) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ type: params.type, token_hash: params.tokenHash });
    if (!error) return NextResponse.redirect(new URL(params.next, request.url));
    console.error("sign-in token verification failed", error.status, error.code, error.message);
  }

  return NextResponse.redirect(new URL("/login?error=expired", request.url));
}
