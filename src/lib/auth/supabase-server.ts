import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseAuthEnv } from "./env";

/**
 * A Supabase client bound to the signed-in person's cookies. For auth only —
 * it acts as that person, not as the service role, and must not be used to
 * read tenant tables.
 */
export async function createSupabaseServerClient() {
  const store = await cookies();
  const { url, anonKey } = supabaseAuthEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy refreshes sessions on every navigation, so nothing is lost.
        }
      },
    },
  });
}
