import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { NextResponse, type NextRequest } from "next/server";
import { sellPayeeHistory, type Facilitator } from "@/lib/platform/payee-history";
import { publicOrigin } from "@/lib/public-origin";
import { GATEWAY_FACILITATOR_URL } from "@/lib/x402/offer";

export const dynamic = "force-dynamic";

const facilitator = new BatchFacilitatorClient({ url: GATEWAY_FACILITATOR_URL }) as unknown as Facilitator;

/**
 * Payee history over x402 (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md §2): open to any
 * caller who pays, through Circle Gateway nanopayments on Arc testnet. See `sellPayeeHistory`.
 */
export async function GET(request: NextRequest) {
  const answer = await sellPayeeHistory(
    {
      address: request.nextUrl.searchParams.get("address"),
      paymentHeader: request.headers.get("payment-signature"),
      origin: publicOrigin(),
    },
    { facilitator }
  );
  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
}
