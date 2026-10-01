import { NextResponse } from "next/server";
import { runLiveOrganizations, runScheduledCycle } from "@/lib/agent/cron";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { takeAgentCycleToken } from "@/lib/rate-limit";
import { deliverPendingWebhooks } from "@/lib/webhooks/deliver";
import { withoutDispatchSoon } from "@/lib/webhooks/dispatch-soon";

export const maxDuration = 300;

/** The webhook dispatch after a tick gets at most this long (webhooks design W3). */
const WEBHOOK_DISPATCH_MS = 30_000;
/** Kept free at the end of `maxDuration` for the dispatch to hand back and the response to go out. */
const WEBHOOK_DISPATCH_MARGIN_MS = 15_000;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

export async function POST(request: Request) {
  const startedAt = Date.now();
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
    // `maxDuration` is 300 seconds, while a fully hung payment can consume
    // about 115 seconds across balance/token reads, submission and settlement.
    // A payout to another chain through CCTP is two such transactions (an
    // approve and a burn) plus a mint wait of at most 20 s, so a fully hung
    // one can take about 235 seconds; two in one tick can outrun the budget.
    // A killed tick pays nothing twice: the intent resends under the same
    // Circle keys. Revisit sequential execution before a second organization
    // goes live.
    //
    // Each scheduled cycle is followed by the digest of payables waiting for
    // a decision (notifications design N1, N2); it never changes the result.
    // Dispatch-soon is off for the cycles: the dispatch below sends what they
    // queued within the tick's own budget, and one scheduled after the
    // response could run into `maxDuration` when that budget is spent.
    const results = await withoutDispatchSoon(() => runLiveOrganizations(runScheduledCycle));

    // The cycles' ledger entries go out to webhook endpoints right away
    // (webhooks design W3), within what is left of this invocation: at most
    // 30 seconds, and never so long that the tick would outrun `maxDuration`.
    // When nothing is left it is skipped; the 10-minute schedule picks up the
    // rest. Best-effort: it never changes the tick's status or body.
    const dispatchMs = Math.min(
      WEBHOOK_DISPATCH_MS,
      maxDuration * 1000 - (Date.now() - startedAt) - WEBHOOK_DISPATCH_MARGIN_MS
    );
    if (dispatchMs > 0) {
      try {
        await deliverPendingWebhooks({ deadlineMs: dispatchMs });
      } catch {
        console.error("webhook dispatch after the tick failed");
      }
    }

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
