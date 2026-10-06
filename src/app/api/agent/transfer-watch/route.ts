import { NextResponse } from "next/server";
import { watchStuckTransfers } from "@/lib/agent/transfer-watch";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { takeTransferWatchToken } from "@/lib/rate-limit";

/** A watch reads each workspace's payments in flight and asks Circle about the few past their wait (stuck-transfer alert D3). */
export const maxDuration = 300;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Tells the workspace's people about a live payment that has not confirmed (docs/superpowers/specs/2026-10-06-stuck-
 * transfer-alert-design.md). Called every 5 minutes by .github/workflows/transfer-watch.yml with the agent's bearer
 * token, like the FX watch. It reads and tells; it never sends, retries or settles a payment.
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!takeTransferWatchToken(clientIp(request))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  try {
    const organizations = await watchStuckTransfers();
    // A workspace the watch could not read is one whose people may not be told: the run fails, so the workflow shows it
    // red rather than green (final review M4). Which workspaces stays in the server log, never in the answer.
    const failed = organizations.filter((organization) => organization.error);
    if (failed.length > 0) {
      console.error("transfer watch failed in", failed.map((organization) => organization.slug));
      return NextResponse.json({ ok: false, error: `The transfer watch failed in ${failed.length} workspace${failed.length === 1 ? "" : "s"}.` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, organizations });
  } catch (error) {
    // Never echo more than that it failed: the error's detail stays in the server log.
    console.error("transfer watch failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ ok: false, error: "The transfer watch failed." }, { status: 500 });
  }
}
