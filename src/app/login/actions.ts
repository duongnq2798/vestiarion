"use server";

import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/auth/routes";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

export interface LoginState {
  ok: boolean;
  message: string;
}

/** Supabase checks this against its allow-list of redirect URLs, so a forged Host cannot send the link elsewhere. */
async function callbackUrl(next: FormDataEntryValue | null): Promise<string> {
  const h = await headers();
  const origin = h.get("origin") ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const target = safeNext(typeof next === "string" ? next : null);
  return `${origin}/auth/callback?next=${encodeURIComponent(target)}`;
}

export async function signInWithEmail(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { ok: false, message: "Enter a valid email address." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: await callbackUrl(formData.get("next")), shouldCreateUser: true },
  });
  if (error) {
    console.error("sign-in link failed", error.message);
    return { ok: false, message: "We could not send a sign-in link just now. Try again in a minute." };
  }
  return { ok: true, message: `Check ${email} for a sign-in link, and open it in this browser.` };
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: await callbackUrl(formData.get("next")) },
  });
  if (error || !data.url) redirect("/login?error=google");
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
