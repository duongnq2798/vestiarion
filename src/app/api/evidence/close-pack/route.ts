import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { getSessionUser } from "@/lib/auth/session";
import { closePackCsv, closePackFileName, closePackJson } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import { readClosePack } from "@/lib/close-pack/read";
import { CLOSE_PACK_EXPORT_LIMIT, recentClosePackExportsBy, recordClosePackExport } from "@/lib/close-pack/record";
import { inOrg } from "@/lib/dal/scope";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

/**
 * One workspace's month as a close pack file (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP12-CP15):
 * `GET /api/evidence/close-pack?org=<slug>&month=YYYY-MM&format=csv|json`. The audit export's gate, in its order: a
 * cross-site request is refused before anything is read, then the session, then a bad format or month before the
 * workspace is looked up, then the membership, read afresh on this request, so a non-member gets the same 404 as a
 * workspace that does not exist. Every member may download it, as every member reads the evidence pages.
 *
 * With no format it answers the signed JSON; with no month, last month. The file is built for this request in the
 * workspace's scope, and its exact bytes are hashed into the download's own `close_pack_exported` entry, appended best
 * effort before it is sent (CP13). Ten downloads per person in ten minutes, counted from those entries (CP15).
 */
export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Download the close pack from the workspace." }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to download this close pack." }, { status: 401 });
  const format = params.get("format") ?? "json";
  if (format !== "csv" && format !== "json") return NextResponse.json({ error: "format must be csv or json" }, { status: 400 });
  const now = new Date();
  const month = closePackMonth(params.get("month"), now);
  if (!month) return NextResponse.json({ error: "month must be YYYY-MM, and not a month still to come" }, { status: 400 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership || !can(membership.role, "workspace.read")) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const result = await inOrg({ user, membership }, async () => {
      if ((await recentClosePackExportsBy(user.id, now)) >= CLOSE_PACK_EXPORT_LIMIT.count) return { limited: true as const };
      const pack = await readClosePack({ month, workspace: { slug: membership.slug, name: membership.name }, now });
      const origin = publicOrigin();
      const body = format === "csv" ? closePackCsv(pack, { origin }) : closePackJson(pack, { origin });
      // The SHA-256 of the exact bytes served, the CSV's byte-order mark included, so a copy can be matched to its entry.
      const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
      await recordClosePackExport({ orgId: membership.orgId, userId: user.id, pack, format, sha256 });
      return { limited: false as const, pack, body };
    });

    if (result.limited) {
      return NextResponse.json(
        { error: "Too many close pack downloads in the last 10 minutes. Try again later." },
        { status: 429, headers: { "retry-after": String(CLOSE_PACK_EXPORT_LIMIT.windowMs / 1000) } }
      );
    }
    return new Response(result.body, {
      headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${closePackFileName(membership.slug, result.pack.month, result.pack.ended, format)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("close pack download failed", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "The close pack could not be read." }, { status: 500 });
  }
}
