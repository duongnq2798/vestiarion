import { after } from "next/server";
import { asanaProviderFromEnv } from "@/lib/asana/provider";
import { handleAsanaWebhook } from "@/lib/asana/webhook";
import { webhookStore } from "@/lib/asana/webhook-store";
import { rereadForWebhook } from "@/lib/asana/workspace";

/**
 * Asana's webhook for one linked task (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A11, A12): the
 * X-Hook-Secret handshake once, then deliveries signed with X-Hook-Signature, each answered at once and followed, after
 * the answer, by a read of the task through Asana's API. Nothing in a delivery is believed. Not there unless Asana is
 * configured.
 */

export const dynamic = "force-dynamic";
/** The answer is immediate; the read after it takes a few seconds. */
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ hook: string }> }): Promise<Response> {
  const provider = asanaProviderFromEnv();
  if (!provider) return Response.json({ error: "not_found" }, { status: 404 });
  const { hook } = await params;
  return handleAsanaWebhook(request, hook, {
    store: webhookStore(),
    defer: (work) => after(work),
    reread: (webhook) => rereadForWebhook(webhook, provider),
  });
}
