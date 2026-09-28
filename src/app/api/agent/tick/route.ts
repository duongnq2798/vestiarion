import { NextResponse } from "next/server";
import { runAgentCycle } from "@/lib/agent/orchestrator";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { withFoundingOrg } from "@/lib/dal/scope";
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
    // The founding organization, named explicitly: there is no default
    // organization to fall back on. Step 5 of the spec replaces this with
    // iterating every organization that is due (§4.4).
    const result = await withFoundingOrg(() => runAgentCycle());
    return NextResponse.json(result);
  } catch (err) {
    console.error("agent cycle failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
