import { after } from "next/server";
import { siteOrigin } from "@/lib/auth/env";
import { handleInbound } from "@/lib/email-inbox/receive";
import { inboxSettingsFromEnv } from "@/lib/email-inbox/settings";

/**
 * Resend's webhook for an email at a workspace's invoice address (docs/superpowers/specs/2026-10-03-email-invoices-design.md
 * E3, E4). Not there unless invoices by email are configured; closed to anything Resend did not sign; answered at once,
 * with the reading done after the response.
 */

export const dynamic = "force-dynamic";
/** One email from Resend, one attachment, and a read by the model, after the response. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const settings = inboxSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return handleInbound(request, { settings, origin: siteOrigin(), defer: (work) => after(work) });
}
