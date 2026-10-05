import { NextResponse } from "next/server";
import { watchFxHolds } from "@/lib/agent/fx-watch";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { takeFxWatchToken } from "@/lib/rate-limit";

/** A watch runs at most a cycle per workspace whose EURC payable a fresh quote cleared (FX re-evaluation F4). */
export const maxDuration = 300;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Decides again, without a person, the EURC payables a fresh quote cleared (docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md).
 * Called every 5 minutes by .github/workflows/fx-watch.yml with the agent's bearer token, like the tick.
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!takeFxWatchToken(clientIp(request))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  try {
    return NextResponse.json({ ok: true, organizations: await watchFxHolds() });
  } catch (error) {
    // Never echo more than that it failed: the error's detail stays in the server log.
    console.error("fx watch failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ ok: false, error: "The FX watch failed." }, { status: 500 });
  }
}
