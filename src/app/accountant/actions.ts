"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { siteOrigin } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { CLIENT_LINK_DAYS, ClientLinkError, createClientLink, revokeClientLink } from "@/lib/platform/client-links";

export interface ClientLinkActionResult {
  ok: boolean;
  message: string;
  /** The link just made, shown once. */
  link?: string;
}

const LINK_ID = z.string().uuid();
const TRY_AGAIN = "That did not work. Try again in a moment.";

function fail(error: unknown, what: string): ClientLinkActionResult {
  if (error instanceof ClientLinkError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: TRY_AGAIN };
}

/**
 * Makes a client invite link on the accountant console (docs/superpowers/specs/2026-10-23-accountant-client-links-
 * design.md AC1). A link belongs to no workspace, so the session is the gate, as for accepting an invitation; who may
 * (an accountant in at least one workspace) and the limits are checked by migration 0143's function, for the signed-in
 * person only. The link is returned once and never logged.
 */
export async function createClientLinkAction(_previous: ClientLinkActionResult, formData: FormData): Promise<ClientLinkActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const email = formData.get("email");
  try {
    const made = await createClientLink({ actorId: user.id, email: typeof email === "string" ? email : "", origin: siteOrigin() });
    revalidatePath("/accountant");
    return {
      ok: true,
      link: made.link,
      message: made.email
        ? `Copy this link now and send it to ${made.email}. It works once, for ${CLIENT_LINK_DAYS} days, and only for that address. It will not be shown again.`
        : `Copy this link now and send it to your client. It works once, for ${CLIENT_LINK_DAYS} days. It will not be shown again.`,
    };
  } catch (error) {
    return fail(error, "client link not made");
  }
}

/** Revokes one of the signed-in accountant's own open links (AC1): the function refuses anyone else's. */
export async function revokeClientLinkAction(_previous: ClientLinkActionResult, formData: FormData): Promise<ClientLinkActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const linkId = formData.get("linkId");
  if (typeof linkId !== "string" || !LINK_ID.safeParse(linkId).success) return { ok: false, message: "This link is not valid." };
  try {
    await revokeClientLink({ actorId: user.id, linkId });
    revalidatePath("/accountant");
    return { ok: true, message: "Link revoked. It no longer works." };
  } catch (error) {
    return fail(error, "client link not revoked");
  }
}
