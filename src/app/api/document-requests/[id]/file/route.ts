import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { documentOpenUrl } from "@/lib/document-requests/read";

export const dynamic = "force-dynamic";

/**
 * Opens the document a vendor sent through a request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md
 * ER6), for any member of its workspace: the file lives in the workspace's private storage, and this sends the member on
 * to a one-minute address that downloads it, never shown on Vestiarion's own pages. A cross-site request is refused
 * before anything is read; a non-member gets the same 404 as a request that does not exist. It records no ledger entry.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Open the document from the workspace." }, { status: 403 });
  }
  const { id } = await params;
  const slug = new URL(request.url).searchParams.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to open this document." }, { status: 401 });
  try {
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const url = await inOrg({ user, membership }, () => documentOpenUrl(id));
    if (!url) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (error) {
    console.error("document not opened", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "The document could not be opened." }, { status: 500 });
  }
}
