import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { getSessionUser } from "@/lib/auth/session";
import { simulatesPayments } from "@/lib/capability-read";
import { inOrg } from "@/lib/dal/scope";
import { takeTrackRecordDownloadToken } from "@/lib/rate-limit";
import { trackRecordFileName, trackRecordJson } from "@/lib/track-record/export";
import { readTrackRecord } from "@/lib/track-record/read";
import { recentTrackRecordExportsBy, recordTrackRecordExport, TRACK_RECORD_EXPORT_LIMIT } from "@/lib/track-record/record";

export const dynamic = "force-dynamic";

/**
 * The agent's track record as a file (docs/superpowers/specs/2026-11-07-track-record-design.md TR8):
 * `GET /api/evidence/track-record?org=<slug>`. The close pack's gate, in its order: a cross-site request is refused
 * before anything is read, then the session, then the membership, read afresh, so a non-member gets the same 404 as a
 * workspace that does not exist. Every member may download it. Its exact bytes are hashed into the download's own
 * `track_record_exported` entry, appended best effort before it is sent. Ten downloads per person per workspace in ten
 * minutes, counted from those entries; six a minute per instance, keyed by the workspace's id.
 */
export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Download the track record from the workspace." }, { status: 403 });
  }
  const slug = new URL(request.url).searchParams.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to download this track record." }, { status: 401 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership || !can(membership.role, "workspace.read")) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!takeTrackRecordDownloadToken(`${user.id}:${membership.orgId}`)) {
      return NextResponse.json({ error: "Too many track record downloads in a row. Try again in a minute." }, { status: 429, headers: { "retry-after": "60" } });
    }

    const now = new Date();
    const result = await inOrg({ user, membership }, async () => {
      if ((await recentTrackRecordExportsBy(user.id, now)) >= TRACK_RECORD_EXPORT_LIMIT.count) return { limited: true as const };
      const record = await readTrackRecord({
        workspace: { slug: membership.slug, name: membership.name },
        sandbox: simulatesPayments(membership.mode),
        people: "id",
        now,
      });
      const body = trackRecordJson(record);
      const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
      await recordTrackRecordExport({ orgId: membership.orgId, userId: user.id, record, sha256 });
      return { limited: false as const, record, body };
    });

    if (result.limited) {
      return NextResponse.json(
        { error: "Too many track record downloads in the last 10 minutes. Try again later." },
        { status: 429, headers: { "retry-after": String(TRACK_RECORD_EXPORT_LIMIT.windowMs / 1000) } }
      );
    }
    return new Response(result.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${trackRecordFileName(membership.slug, result.record.readAt)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("track record download failed", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "The track record could not be read." }, { status: 500 });
  }
}
