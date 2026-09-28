import { NextResponse } from "next/server";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { deleteAbandonedSandboxes } from "@/lib/platform/cleanup";

/** Bearer-protected, run daily by `.github/workflows/sandbox-cleanup.yml` (spec §6, §10 step 5b). */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { deleted, failed } = await deleteAbandonedSandboxes();
  return NextResponse.json({ deleted, failed }, { status: failed.length > 0 ? 500 : 200 });
}
