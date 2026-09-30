import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { appendLedgerEntryBestEffort } from "@/lib/ledger-best-effort";
import { buildLedgerExport, exportFileName, ledgerExportCsvChunks, ledgerExportJsonChunks } from "@/lib/ledger-export";

export const dynamic = "force-dynamic";

/**
 * One workspace's signed ledger as a file (audit-export spec §1), for any of
 * its members: viewers already see every entry on the Audit page (E5). Same
 * session check as /api/ledger/verify, and the same 404 for a non-member, so
 * the route never says whether a workspace exists. The export itself is
 * recorded, best effort (E6).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const format = params.get("format") ?? "json";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to export this ledger." }, { status: 401 });
  if (format !== "json" && format !== "csv") return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = await inOrg({ user, membership }, async () => {
      const built = await buildLedgerExport({ slug: membership.slug, name: membership.name });
      const headSeq = built.head?.seq ?? 0;
      try {
        await appendLedgerEntryBestEffort(membership.orgId, {
          actor: "human",
          domain: "system",
          action: "ledger_exported",
          summary: `Ledger exported as ${format.toUpperCase()}: ${built.entries.length} entries, up to #${headSeq}`,
          detail: { by: user.id, format, entries: built.entries.length, headSeq },
        });
      } catch (error) {
        console.error("ledger export: the export could not be recorded", membership.orgId, error instanceof Error ? error.message : error);
      }
      return built;
    });

    const chunks = format === "json" ? ledgerExportJsonChunks(doc) : ledgerExportCsvChunks(doc);
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
        "content-disposition": `attachment; filename="${exportFileName(membership.slug, doc.head?.seq ?? 0, format)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("ledger export failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The ledger could not be exported." }, { status: 500 });
  }
}
