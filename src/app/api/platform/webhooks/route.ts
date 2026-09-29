import { NextResponse } from "next/server";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { deliverPendingWebhooks } from "@/lib/webhooks/deliver";

export const maxDuration = 300;

/**
 * Bearer-protected, run every 10 minutes by `.github/workflows/webhooks.yml`
 * (webhooks design W3): one dispatch run, at most 500 deliveries claimed in
 * batches of 25, within 60 seconds (W7).
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Counts only: this body is printed into the workflow's log. Per-delivery
    // detail is in the server log, by delivery and endpoint id.
    const { delivered, failed, retried } = await deliverPendingWebhooks();
    return NextResponse.json({ delivered, failed, retried }, { status: 200 });
  } catch (err) {
    // deliverPendingWebhooks never throws; this is only a backstop.
    console.error("webhook dispatch failed", (err as Error).name);
    return NextResponse.json({ error: "webhook dispatch failed" }, { status: 500 });
  }
}
