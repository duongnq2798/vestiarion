import { growthTeamUser } from "@/lib/growth/gate";
import { exportLeads } from "@/lib/growth/write";

export const dynamic = "force-dynamic";

/**
 * Every lead as a CSV, for the founder dashboard (/admin/growth): the import's columns, then each lead's stage, review
 * status and when it was added. Behind the same team gate as the page, asked again here; anyone else gets the same 404
 * as an address that does not exist.
 */
export async function GET(): Promise<Response> {
  const user = await growthTeamUser();
  if (!user) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  try {
    const csv = await exportLeads();
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="vestiarion-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (error) {
    console.error("growth: export failed", error instanceof Error ? error.message : "unknown error");
    return new Response("The leads could not be read.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
