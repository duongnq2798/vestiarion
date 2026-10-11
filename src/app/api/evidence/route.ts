import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { evidenceDocument, evidenceFileName } from "@/lib/evidence-export";
import { evidenceRequest, readEvidence } from "@/lib/evidence-read";
import { ledgerVerificationKeyring } from "@/lib/ledger";
import { exportKeys } from "@/lib/ledger-export";

export const dynamic = "force-dynamic";

/**
 * One payment's evidence as a JSON file (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E7), for any member
 * of its workspace, as the audit export is: viewers already read the same chain on its page. A cross-site request is
 * refused before anything is read; a non-member gets the same 404 as a workspace that does not exist. It records no
 * ledger entry: it carries one payment's evidence, which every member can see, not the whole ledger.
 */
export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Download the evidence from its page in the workspace." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const slug = params.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to download this evidence." }, { status: 401 });
  const wanted = evidenceRequest(params.get("kind"), params.get("id"));
  if (!wanted) return NextResponse.json({ error: "kind must be invoice or milestone, and id the record's id" }, { status: 400 });

  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = await inOrg({ user, membership }, async () => {
      const read = await readEvidence(wanted.kind, wanted.id);
      if (!read) return null;
      return evidenceDocument({
        chain: read.chain,
        workspace: { slug: membership.slug, name: membership.name },
        keys: exportKeys(ledgerVerificationKeyring()),
        now: new Date(),
      });
    });
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return new Response(JSON.stringify(doc, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${evidenceFileName(membership.slug, wanted.kind, wanted.id)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("evidence download failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The evidence could not be read." }, { status: 500 });
  }
}
