import { NextResponse } from "next/server";
import { evaluateResetGuard, hasValidAgentBearer } from "@/lib/agent-security";
import { withFoundingOrg } from "@/lib/dal/scope";
import { seedDatabase } from "@/lib/seed";

export async function POST(request: Request) {
  const authorized = hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN);
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let confirmation: unknown;
  try {
    const body: unknown = await request.json();
    confirmation = body && typeof body === "object" ? (body as Record<string, unknown>).confirm : undefined;
  } catch {
    confirmation = undefined;
  }

  const guard = evaluateResetGuard({
    authorized,
    confirmation,
    isProduction: process.env.NODE_ENV === "production",
    allowDestructiveReset: process.env.ALLOW_DESTRUCTIVE_RESET === "true",
  });
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    // Bound to the founding organization, like the cron: the platform token
    // that authorizes this names no organization of its own.
    await withFoundingOrg(() => seedDatabase());
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("demo reset failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
