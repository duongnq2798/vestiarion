import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAuthEnv } from "@/lib/auth/env";
import { loginRedirectFor } from "@/lib/auth/routes";

/**
 * Refreshes an expiring session and sends signed-out visitors of product pages
 * to /login. Optimistic only — it reads the cookie and never the database; the
 * pages re-check with `verifySession()`.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseAuthEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [header, value] of Object.entries(headers ?? {})) response.headers.set(header, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const target = loginRedirectFor(request.nextUrl.pathname, request.nextUrl.search, Boolean(data?.claims));
  if (target) return NextResponse.redirect(new URL(target, request.url));
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
