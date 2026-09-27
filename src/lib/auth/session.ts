import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "./supabase-server";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * The authoritative session check. `getUser()` asks Supabase Auth to validate
 * the token rather than trusting the cookie, which is what the proxy's
 * optimistic check cannot do. Memoized per request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
});

export async function verifySession(returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return user;
}
