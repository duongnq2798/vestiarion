import { NextResponse } from "next/server";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { recordRatesForWorkspaces } from "@/lib/fx/rates-job";

export const maxDuration = 300;

/**
 * Bearer-protected, run every hour by Supabase Cron (`supabase/cron/watches.sql`) and by hand from
 * `.github/workflows/fx-rates.yml` (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M5, M6): records the
 * day's reference rates for each workspace that reports or plans in another currency, and the FX variance of each paid
 * bill whose payment-day rate is now recorded. Nothing that decides or pays reads either. Counts only in its answer,
 * which a public workflow log prints; a run that failed in any workspace answers 500 without naming it.
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await recordRatesForWorkspaces();
    return NextResponse.json(result, { status: result.failed > 0 ? 500 : 200 });
  } catch (error) {
    console.error("fx rates job failed", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "fx rates job failed" }, { status: 500 });
  }
}
