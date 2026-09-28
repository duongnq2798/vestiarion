import { NextResponse } from "next/server";
import { membershipFor } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { inOrg } from "@/lib/dal/scope";
import { verifyLedger } from "@/lib/ledger";

export const dynamic = "force-dynamic";

/**
 * Verifies one organization's chain for one of its members. It was public
 * while there was one business; with several, a public endpoint would tell
 * anyone how long each chain is.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("org") ?? "";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to verify this ledger." }, { status: 401 });
  try {
    // Inside the try, so a database error looking the membership up answers
    // with the same fixed JSON as any other failure, not a framework 500.
    const membership = await membershipFor(user.id, slug);
    if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(await inOrg({ user, membership }, () => verifyLedger()));
  } catch (err) {
    console.error("ledger verification failed", err);
    return NextResponse.json({ error: "The ledger could not be verified." }, { status: 500 });
  }
}
