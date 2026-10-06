import { NextResponse } from "next/server";
import { handleCircleNotification } from "@/lib/circle/notify";
import { takeCircleNotificationToken } from "@/lib/rate-limit";

/**
 * Matching reads one row per workspace, but the event cycle it starts runs after the answer, in this invocation: `after`
 * is bounded by this route's duration, and an event cycle may wait 90 seconds for one running, then run (final review C1).
 */
export const maxDuration = 300;

/** Circle's envelopes are a few kilobytes; anything far larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Circle's signed transaction notifications, for every Circle account Vestiarion subscribes
 * (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2). One about a transfer a workspace waits on
 * starts that workspace's event cycle; nothing from the body is recorded (N1).
 */
export async function POST(request: Request) {
  if (!takeCircleNotificationToken(clientIp(request))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large" }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large" }, { status: 413 });

  const outcome = await handleCircleNotification(raw, {
    signature: request.headers.get("x-circle-signature"),
    keyId: request.headers.get("x-circle-key-id"),
  });
  if (outcome.started) console.info("Circle notification started", outcome.started.kind, "in", outcome.started.slug);
  return NextResponse.json({ ok: outcome.status === 200 }, { status: outcome.status });
}
