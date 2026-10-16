import { blindpaySettingsFromEnv } from "@/lib/blindpay/settings";
import { handleBlindpayNotice } from "@/lib/bank-payouts/webhook";

/**
 * BlindPay's notices (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B9), registered on the instance as
 * https://www.vestiarion.xyz/api/integrations/blindpay/webhook: the Svix signature is checked before the body is read, a
 * payout's notice starts a cycle in the workspace waiting on it, and nothing else is done with what it says. Not there
 * unless bank payouts are configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = blindpaySettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  const raw = await request.text();
  const outcome = await handleBlindpayNotice(raw, request.headers, { secret: settings.webhookSecret });
  return Response.json({ ok: outcome.status === 200 }, { status: outcome.status });
}
