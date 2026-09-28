import { NextResponse } from "next/server";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { deleteAbandonedSandboxes } from "@/lib/platform/cleanup";

/** Bearer-protected, run daily by `.github/workflows/sandbox-cleanup.yml` (spec §6, §10 step 5b). */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Counts only: this body is printed into the workflow's log, and sandbox
    // slugs derive from workspace names. The detail is in the server log.
    const { deleted, failed } = await deleteAbandonedSandboxes();
    return NextResponse.json({ deleted, failed }, { status: failed > 0 ? 500 : 200 });
  } catch (err) {
    console.error("sandbox cleanup failed", (err as Error).message);
    return NextResponse.json({ error: "cleanup failed" }, { status: 500 });
  }
}
