import { after } from "next/server";
import { linearProviderFromEnv } from "@/lib/linear/provider";
import { handleLinearWebhook } from "@/lib/linear/webhook";
import { markRevokedAtLinear, rereadForDelivery } from "@/lib/linear/workspace";

/**
 * Linear's app webhook (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN11), registered for the app as
 * https://www.vestiarion.xyz/api/integrations/linear/webhook: each delivery signed with Linear-Signature and dated
 * within a minute is answered at once and followed, after the answer, by a read through Linear's API of the one issue
 * it names, in each workspace connected to its Linear workspace. Nothing in a delivery is believed. Not there unless
 * Linear is configured.
 */

export const dynamic = "force-dynamic";
/** The answer is immediate; the reads after it take a few seconds. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const provider = linearProviderFromEnv();
  if (!provider) return Response.json({ error: "not_found" }, { status: 404 });
  return handleLinearWebhook(request, {
    secret: provider.webhookSecret,
    defer: (work) => after(work),
    reread: (event) => rereadForDelivery(event, provider),
    revoked: (organizationId) => markRevokedAtLinear(organizationId),
  });
}
