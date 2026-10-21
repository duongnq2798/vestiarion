import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { parsePeriod, payeeLockEvidenceFileName } from "@/lib/payee-lock-evidence";
import { readPayeeLockEvidence } from "@/lib/payee-lock-evidence-read";
import { payeeLockEvidenceCsv } from "@/lib/payee-lock-evidence-report";
import { takeEvidencePackToken } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The payee lock's evidence pack as a JSON file (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP1),
 * for any member of its workspace, as the audit export and a payment's evidence are: members already see the address
 * changes and the ledger. A cross-site request is refused before anything is read; a non-member gets the same 404 as a
 * workspace that does not exist. It records no ledger entry. `format=csv` answers one row per address change instead
 * (EP9), the entries' signatures staying in the JSON file.
 */
export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Download the evidence pack from the workspace." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to download this evidence." }, { status: 401 });
  if (!takeEvidencePackToken(user.id)) {
    return NextResponse.json({ error: "Too many downloads. Try again in a minute." }, { status: 429, headers: { "retry-after": "60" } });
  }
  const period = parsePeriod(params.get("from"), params.get("to"));
  if (!period) return NextResponse.json({ error: "from and to must be days as YYYY-MM-DD, from no later than to" }, { status: 400 });
  const format = params.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = await inOrg({ user, membership }, () =>
      readPayeeLockEvidence({ workspace: { slug: membership.slug, name: membership.name }, period })
    );
    const csv = format === "csv";
    return new Response(csv ? payeeLockEvidenceCsv(doc) : JSON.stringify(doc, null, 2), {
      headers: {
        "content-type": csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${payeeLockEvidenceFileName(membership.slug, period, format)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("payee lock evidence download failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The evidence pack could not be read." }, { status: 500 });
  }
}
