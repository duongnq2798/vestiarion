import { NextResponse } from "next/server";
import { readAgentActivity } from "@/lib/agent-activity-read";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";

export const dynamic = "force-dynamic";

/**
 * What the agent is doing in one workspace, and what it decided after `since`, for a member's open page (agent
 * activity): `GET /api/agent/activity?org=<slug>&since=<seq>`. Members only, like the ledger's verify route; the
 * answer is never cached.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const sinceParam = params.get("since");
  const since = sinceParam !== null && /^\d{1,12}$/.test(sinceParam) ? Number(sinceParam) : null;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to see the agent's activity." }, { status: 401 });
  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const activity = await inOrg({ user, membership }, () => readAgentActivity(since));
    return NextResponse.json(activity, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("agent activity failed", err);
    return NextResponse.json({ error: "The agent's activity could not be read." }, { status: 500 });
  }
}
