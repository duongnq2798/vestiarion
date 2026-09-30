"use server";

import "server-only";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";
import { accountDeletionPlan, AccountDeletionError, deleteAccount, type AccountDeletionPlan } from "@/lib/platform/delete-account";

/**
 * Your own account (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md §6).
 * Not an organization action: deleting an account needs no workspace role
 * (A1), so the gate is the session, as for the onboarding actions. The person
 * acted on is always the session's user; nothing in the form names them.
 */

export interface DeleteAccountActionResult {
  ok: boolean;
  message: string;
}

export type AccountDeletionPlanResult = { ok: true; plan: AccountDeletionPlan } | { ok: false; message: string };

const SIGNED_OUT = "Your session has ended. Sign in again.";
const GENERIC = "Something went wrong; try again.";

/**
 * What deleting the account would do, read when its dialog opens. Loaded then
 * rather than with every page: the menu that opens the dialog is on every
 * workspace page, and the plan costs a read per workspace the person owns.
 */
export async function accountDeletionPlanAction(): Promise<AccountDeletionPlanResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: SIGNED_OUT };
  try {
    return { ok: true, plan: await accountDeletionPlan(user.id) };
  } catch {
    console.error("account: accountDeletionPlanAction failed");
    return { ok: false, message: "Your workspaces could not be read; try again." };
  }
}

/** Form fields: `confirmText`. */
export async function deleteAccountAction(_previous: DeleteAccountActionResult, formData: FormData): Promise<DeleteAccountActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: SIGNED_OUT };
  const confirmText = formData.get("confirmText");
  try {
    await deleteAccount({ userId: user.id, confirmText: typeof confirmText === "string" ? confirmText : "" });
  } catch (error) {
    if (error instanceof AccountDeletionError) return { ok: false, message: error.message };
    // Logged by the action's name alone: an auth or database message may quote the person.
    console.error("account: deleteAccountAction failed");
    return { ok: false, message: GENERIC };
  }
  // The account is gone. Signing out clears this browser's session cookies.
  // Even the local scope calls Supabase's /logout with the session's token;
  // for a deleted user that answers 401, 403 or 404, which auth-js ignores
  // before removing the session here. Any other failure changes nothing the
  // person can act on.
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The cookies expire with the deleted user's tokens regardless.
  }
  // `redirect` throws to navigate, so it stays outside every `try` above.
  redirect("/");
}
