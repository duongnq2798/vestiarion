import { NextResponse } from "next/server";
import { runLiveOrganizations } from "@/lib/agent/cron";
import { runAgentCycle } from "@/lib/agent/orchestrator";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { takeAgentCycleToken } from "@/lib/rate-limit";

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
    // capped by sandboxCyclesUsedToday (§10 step 5a).
    const results = await runLiveOrganizations(() => runAgentCycle());
    const organizations = results.map((result) =>
      result.ok
        ? { slug: result.slug, ok: true as const, lines: result.result.lines.length }
        // Never echo more than the error's message: whatever else it carries
        // isn't this endpoint's to expose.
        : { slug: result.slug, ok: false as const, error: result.error }
    );
    const status = results.every((result) => result.ok) ? 200 : 500;
    return NextResponse.json({ organizations }, { status });
  } catch (err) {
    console.error("agent cycle failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
