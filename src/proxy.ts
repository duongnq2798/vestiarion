import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAuthEnv, supabaseAuthEnvOrNull } from "@/lib/auth/env";
import { loginRedirectFor, requiresSession } from "@/lib/auth/routes";

/**
 * Refreshes an expiring session and sends signed-out visitors of product pages
 * to /login. Optimistic only — it reads the cookie and never the database; the
 * pages re-check with `verifySession()`.
 *
 * A public page must not go down because sign-in is misconfigured, so the
 * routing decision comes first: only a path that `requiresSession` reads the
 * env strictly (and throws if it is missing). A protected path still fails
 * loudly, same as before.
 */
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (!requiresSession(pathname) && !supabaseAuthEnvOrNull()) {
    return NextResponse.next();
  }

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
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|icons/).*)"],
};
