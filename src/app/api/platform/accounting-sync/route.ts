import { NextResponse } from "next/server";
import { accountingProvider } from "@/lib/accounting-providers";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { sweepAccounting } from "@/lib/connectors/sweep";

/** A sweep stops starting syncs after 240 seconds (docs/superpowers/specs/2026-10-12-xero-connector-design.md X7). */
export const maxDuration = 300;

/**
 * Brings bills in from the accounting tools workspaces connected, without a person: bearer-protected, run every 15
 * minutes by Supabase Cron (`supabase/cron/watches.sql`) and by hand from `.github/workflows/accounting-sync.yml`.
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Counts only: this body is printed into the workflow's log, and the repository is public.
    return NextResponse.json(await sweepAccounting({ providerFor: accountingProvider }), { status: 200 });
  } catch (error) {
    console.error("accounting sync failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "The accounting sync failed." }, { status: 500 });
  }
}
