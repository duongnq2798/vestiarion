import { NextResponse } from "next/server";
import {
  buildHandoff,
  HANDOFF_LIMIT,
  handoffCsvChunks,
  handoffFileName,
  handoffJsonChunks,
  handoffPeriod,
  recentHandoffsBy,
} from "@/lib/accountant/handoff";
import { membershipFor } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { appendLedgerEntryBestEffort } from "@/lib/ledger-best-effort";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

/**
 * One workspace's month as a hand-off file for its accountant (docs/superpowers/specs/2026-10-13-accountant-console-design.md
 * A7): `GET /api/accountant/handoff?org=<slug>&format=csv|json&month=YYYY-MM`. The audit export's gate, in the same
 * order: a cross-site request is refused before anything is read, then the session, then the membership, read afresh
 * from the database on this request, so a member removed a moment ago gets the same 404 as someone who never was one,
 * and the route never says whether a workspace exists. Every member may export, as every member reads the workspace.
 * Nothing is kept: the file is built for this request, in the workspace's scope, and recorded in its ledger.
 */
export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Start the hand-off from the accountant console." }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const format = params.get("format") ?? "csv";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to export this hand-off." }, { status: 401 });
  if (format !== "json" && format !== "csv") return NextResponse.json({ error: "format must be csv or json" }, { status: 400 });
  const now = new Date();
  const period = handoffPeriod(params.get("month"), now);
  if (!period) return NextResponse.json({ error: "month must be YYYY-MM, and not a month still to come" }, { status: 400 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership || !can(membership.role, "workspace.read")) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const result = await inOrg({ user, membership }, async () => {
      if ((await recentHandoffsBy(user.id, now)) >= HANDOFF_LIMIT.count) return { limited: true as const };
      const doc = await buildHandoff(membership, period, { now, origin: publicOrigin() });
      await appendLedgerEntryBestEffort(membership.orgId, {
        actor: "human",
        domain: "system",
        action: "handoff_exported",
        summary: `Hand-off for ${period.label} exported as ${format.toUpperCase()}: ${doc.decisions.length} decisions, ${doc.payments.length} payments, ${doc.bookings.length} bookings, ${doc.openItems.length} open items`,
        detail: {
          by: user.id,
          format,
          month: period.key,
          decisions: doc.decisions.length,
          payments: doc.payments.length,
          bookings: doc.bookings.length,
          openItems: doc.openItems.length,
          headSeq: doc.ledgerHead?.seq ?? 0,
        },
      });
      return { limited: false as const, doc };
    });

    if (result.limited) {
      return NextResponse.json(
        { error: "Too many hand-offs in the last 10 minutes. Try again later." },
        { status: 429, headers: { "retry-after": String(HANDOFF_LIMIT.windowMs / 1000) } }
      );
    }
    const chunks = format === "json" ? handoffJsonChunks(result.doc) : handoffCsvChunks(result.doc);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
    });
    return new Response(body, {
      headers: {
        "content-type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${handoffFileName(membership.slug, period, format)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("hand-off export failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "The hand-off could not be exported." }, { status: 500 });
  }
}
