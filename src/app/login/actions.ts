"use server";

import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { AFTER_SIGN_IN_COOKIE } from "@/lib/auth/after-sign-in";
import { siteOrigin } from "@/lib/auth/env";
import { signInFailureMessage } from "@/lib/auth/messages";
import { DEFAULT_AFTER_LOGIN, safeNext } from "@/lib/auth/routes";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

export interface LoginState {
  ok: boolean;
  message: string;
}

function targetFor(next: FormDataEntryValue | null): string {
  return safeNext(typeof next === "string" ? next : null);
}

/**
 * Built from configuration, never from request headers — Origin and Host are
 * client-supplied, and a forged Host could otherwise steer a magic link at an
 * attacker's domain if the Supabase redirect allow-list is broad.
 */
function callbackUrl(target: string): string {
  return `${siteOrigin()}/auth/callback?next=${encodeURIComponent(target)}`;
}

/**
 * Remembers a non-default destination for `/auth/confirm` to fall back to.
 * The Supabase email templates (supabase/templates/*.html) link straight to
 * `/auth/confirm?token_hash=…&type=email`, dropping the `next` this function
 * built into `emailRedirectTo` — so without this cookie, every email sign-in
 * that carried a `next` would land on the default instead (see
 * `src/lib/auth/after-sign-in.ts`). Never logged: it can hold an invitation
 * token.
 *
 * A default target deletes any cookie left over from an earlier sign-in
 * instead of leaving it in place: on a shared browser, an old invitation (or
 * other) destination must not hijack a later, unrelated sign-in.
 */
async function rememberAfterSignIn(target: string): Promise<void> {
  const store = await cookies();
  if (target === DEFAULT_AFTER_LOGIN) {
    store.delete(AFTER_SIGN_IN_COOKIE);
    return;
  }
  store.set(AFTER_SIGN_IN_COOKIE, target, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 3600,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function signInWithEmail(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { ok: false, message: "Enter a valid email address." };

  const target = targetFor(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl(target), shouldCreateUser: true },
  });
  if (error) {
    console.error("sign-in link failed", error.status, error.code, error.message);
    return { ok: false, message: signInFailureMessage(error) };
  }
  await rememberAfterSignIn(target);
  return { ok: true, message: `Check ${email} for a sign-in link, and open it in this browser.` };
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const target = targetFor(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(target) },
  });
  if (error || !data.url) redirect("/login?error=google");
  await rememberAfterSignIn(target);
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
