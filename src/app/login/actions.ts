"use server";

import "server-only";

import { redirect } from "next/navigation";
import { z } from "zod";
import { siteOrigin } from "@/lib/auth/env";
import { signInFailureMessage } from "@/lib/auth/messages";
import { safeNext } from "@/lib/auth/routes";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

export interface LoginState {
  ok: boolean;
  message: string;
}

/**
 * Built from configuration, never from request headers — Origin and Host are
 * client-supplied, and a forged Host could otherwise steer a magic link at an
 * attacker's domain if the Supabase redirect allow-list is broad.
 */
function callbackUrl(next: FormDataEntryValue | null): string {
  const target = safeNext(typeof next === "string" ? next : null);
  return `${siteOrigin()}/auth/callback?next=${encodeURIComponent(target)}`;
}

export async function signInWithEmail(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { ok: false, message: "Enter a valid email address." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl(formData.get("next")), shouldCreateUser: true },
  });
  if (error) {
    console.error("sign-in link failed", error.status, error.code, error.message);
    return { ok: false, message: signInFailureMessage(error) };
  }
  return { ok: true, message: `Check ${email} for a sign-in link, and open it in this browser.` };
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(formData.get("next")) },
  });
  if (error || !data.url) redirect("/login?error=google");
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
