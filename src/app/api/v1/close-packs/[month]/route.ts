import { CLOSE_PACK_TOO_LARGE, documentAnswer, evidenceReadsLimited, MONTH_REFUSED, workspaceInScope } from "@/lib/api/evidence";
import { apiError, guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import { closePackDocument } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import { readClosePack } from "@/lib/close-pack/read";
import { publicOrigin } from "@/lib/public-origin";
import { takeApiEvidenceToken } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A month's close pack (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA1-EA3, EA7,
 * EA8): the file the Monthly close pack page's Download signed JSON gives, `vestiarion-close-pack/1`, with members named
 * by user id. `month` is `YYYY-MM`, this month allowed and read so far; one that does not read, before 2020 or to come is
 * refused before anything is read, and spends no evidence read (EA5, EA6). An answer over 4 MB is refused. Unlike the
 * download, it records no `close_pack_exported`: a job that reads a month every hour would fill the ledger (CP18).
 */
export async function GET(request: Request, { params }: { params: Promise<{ month: string }> }) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const { month: asked } = await params;
  // A month left out reads as last month on the page; here the path always names one, so "" is refused too.
  const month = asked ? closePackMonth(asked, new Date()) : null;
  if (!month) return apiError("invalid_request", MONTH_REFUSED);
  if (!takeApiEvidenceToken(guard.key.keyId)) return evidenceReadsLimited();
  return handleApiRequest("GET /api/v1/close-packs/{month}", guard.key, async () => {
    const pack = await readClosePack({ month, workspace: await workspaceInScope(), people: "id" });
    return documentAnswer(closePackDocument(pack, { origin: publicOrigin() }), { tooLarge: CLOSE_PACK_TOO_LARGE });
  });
}
