import type { NextResponse } from "next/server";
import { db } from "@/lib/dal";
import { apiError, guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import type { ApiResource } from "@/lib/api/contract";
import {
  mapCounterparty,
  mapScreeningHistory,
  type CounterpartyPayload,
  type ScreeningHistoryPayload,
} from "@/lib/api/counterparties";

export const dynamic = "force-dynamic";

export interface CounterpartyDetailPayload extends CounterpartyPayload {
  screeningHistory: ScreeningHistoryPayload[];
}

const COUNTERPARTY_SELECT =
  "id, name, role, address, chain, jurisdiction, risk_level, risk_notes, baseline_payment_limit, payment_limit, last_screened_at, performance_score, performance_inputs, created_at";
const CHECK_SELECT =
  "id, risk_level, source, notes, raw_score, matched_entity_id, screening_mode, status, created_at";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const { id } = await params;
  return handleApiRequest(
    "GET /api/v1/counterparties/{id}",
    guard.key,
    async (): Promise<ApiResource<CounterpartyDetailPayload> | NextResponse> => {
      // The lookup carries the organization, so another organization's
      // counterparty id is answered as not found rather than served.
      const client = db();
      const counterpartyResult = await client
        .from("counterparties")
        .select(COUNTERPARTY_SELECT)
        .eq("id", id)
        .maybeSingle();
      if (counterpartyResult.error) throw new Error(counterpartyResult.error.message);
      if (!counterpartyResult.data) {
        return apiError("not_found", `Counterparty "${id}" was not found.`);
      }

      const checksResult = await client
        .from("compliance_checks")
        .select(CHECK_SELECT)
        .eq("counterparty_id", id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (checksResult.error) throw new Error(checksResult.error.message);

      return {
        data: {
          ...mapCounterparty(counterpartyResult.data as Record<string, unknown>),
          screeningHistory: (checksResult.data as Array<Record<string, unknown>>).map(
            mapScreeningHistory
          ),
        },
      };
    }
  );
}
