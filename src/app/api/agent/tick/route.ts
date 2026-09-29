import { NextResponse } from "next/server";
import { runLiveOrganizations, runScheduledCycle } from "@/lib/agent/cron";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { takeAgentCycleToken } from "@/lib/rate-limit";

export const maxDuration = 300;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!takeAgentCycleToken(clientIp(request))) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  try {
    // Every `live` organization gets its own cycle, in its own scope; one
    // organization's failure does not stop the rest (§4.4). Sandbox
    // organizations are not in the cron — their cycles run from the console,
    // capped inside begin_cycle_run via runAgentCycle's dailyCap (§10 step
    // 5a). Passing none here is correct: this path only ever runs live
    // organizations, which begin_cycle_run never caps.
    //
    // Live organizations run sequentially in this one invocation, so the
    // tick's wall time is the sum of their cycles, not the slowest one.
    // Today there is one live organization. Revisit `maxDuration` or running
    // organizations in parallel once a second one goes live.
    //
    // Each scheduled cycle is followed by the digest of payables waiting for
    // a decision (notifications design N1, N2); it never changes the result.
    const results = await runLiveOrganizations(runScheduledCycle);
    const organizations = results.map((result) => {
      if (!result.ok) {
        // Never echo more than the error's message: whatever else it
        // carries isn't this endpoint's to expose.
        return { slug: result.slug, ok: false as const, error: result.error };
      }
      if ("skipped" in result) {
        return { slug: result.slug, ok: true as const, skipped: result.skipped };
      }
      return { slug: result.slug, ok: true as const, lines: result.result.lines.length };
    });
    const status = results.every((result) => result.ok) ? 200 : 500;
    return NextResponse.json({ organizations }, { status });
  } catch (err) {
    console.error("agent cycle failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
