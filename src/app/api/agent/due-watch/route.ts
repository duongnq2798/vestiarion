import { NextResponse } from "next/server";
import { watchDueWork } from "@/lib/agent/due-watch";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { takeDueWatchToken } from "@/lib/rate-limit";

/** A run checks every live workspace and runs at most one cycle in each; none starts after 180 seconds (DW7). */
export const maxDuration = 300;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Runs a cycle where work became due only because time passed: a scheduled cycle the tick missed, or the end of the
 * payee lock's wait (docs/superpowers/specs/2026-10-21-due-work-watch-design.md). Called every 5 minutes by Supabase
 * Cron (supabase/cron/watches.sql), and by hand from .github/workflows/due-watch.yml, with the agent's bearer token,
 * like the tick.
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!takeDueWatchToken(clientIp(request))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  try {
    const results = await watchDueWork();
    const organizations = results.map((result) => {
      // A workspace's error stays in the server log: the response says only that it failed.
      if (!result.ok) return { slug: result.slug, ok: false as const };
      if ("skipped" in result) return { slug: result.slug, ok: true as const, skipped: result.skipped };
      return { slug: result.slug, ok: true as const, ...result.result };
    });
    return NextResponse.json({ organizations }, { status: results.every((result) => result.ok) ? 200 : 500 });
  } catch (error) {
    console.error("due watch failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "The due-work watch failed." }, { status: 500 });
  }
}
