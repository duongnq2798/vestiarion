import { siteOrigin } from "@/lib/auth/env";
import { membershipFor } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { getSessionUser } from "@/lib/auth/session";
import { BankPayoutsError, finishBankPayoutsSetUp } from "@/lib/bank-payouts/commands";
import { blindpaySettingsFromEnv, readTermsReturn } from "@/lib/blindpay/settings";
import { withOrg } from "@/lib/dal/scope";

/**
 * Where BlindPay sends an owner back once they accepted its terms (docs/superpowers/specs/2026-10-16-bank-payouts-design.md
 * B3), with `tos_id`. The same signed-in owner of the workspace named in `?org=` finishes the set-up: the workspace's
 * BlindPay customer is made with those terms. Anyone else, or a missing `tos_id`, changes nothing. Not there unless bank
 * payouts are configured.
 */

export const dynamic = "force-dynamic";
// BlindPay reads the business's documents before it makes the customer.
export const maxDuration = 90;

const back = (slug: string, outcome: string) => Response.redirect(`${siteOrigin()}/o/${encodeURIComponent(slug)}/settings?bankpayouts=${outcome}#bank-payouts`, 303);

export async function GET(request: Request): Promise<Response> {
  if (!blindpaySettingsFromEnv()) return Response.json({ error: "not_found" }, { status: 404 });
  const { slug, tosId } = readTermsReturn(new URL(request.url));
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return Response.json({ error: "bad_request" }, { status: 400 });
  const user = await getSessionUser();
  if (!user) return Response.redirect(`${siteOrigin()}/login?next=${encodeURIComponent(`/o/${slug}/settings#bank-payouts`)}`, 303);
  const membership = await membershipFor(user.id, slug);
  if (!membership || !can(membership.role, "org.administer")) return back(slug, "forbidden");
  if (!/^to_[A-Za-z0-9_]{4,60}$/.test(tosId)) return back(slug, "no_terms");
  try {
    await withOrg(
      membership.orgId,
      () => finishBankPayoutsSetUp({ actorId: user.id, tosId, workspaceName: membership.name, contactEmail: user.email ?? "owner@example.com" }),
      { userId: user.id }
    );
    return back(slug, "set_up");
  } catch (error) {
    if (!(error instanceof BankPayoutsError)) console.error("bank payouts: set-up did not finish", error instanceof Error ? error.message : "unknown error");
    return back(slug, "failed");
  }
}
