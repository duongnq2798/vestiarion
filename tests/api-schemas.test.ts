import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { CounterpartyDetailPayload } from "@/app/api/v1/counterparties/[id]/route";
import type { LedgerEntryPayload } from "@/app/api/v1/ledger/route";
import type { StatusPayload } from "@/app/api/v1/status/route";
import type { ApiError, ApiPage } from "@/lib/api/contract";
import type { CounterpartyPayload, ScreeningHistoryPayload } from "@/lib/api/counterparties";
import type { InvoicePayload } from "@/lib/api/invoices";
import type { MilestonePayload } from "@/lib/api/milestones";
import type { TreasuryPayload } from "@/lib/api/treasury";
import type {
  CycleRunTelemetry,
  CycleSnapshotTelemetry,
  InsightsData,
  ScreeningTelemetry,
  TransferTelemetry,
  TreasuryMoveTelemetry,
} from "@/lib/insights";
import type { VerificationResult } from "@/lib/ledger";
import * as S from "@/lib/api/schemas";
import { OPERATIONS } from "@/lib/api/openapi";

/**
 * The Zod schemas are what the docs and the OpenAPI document are built from;
 * the interfaces are what the routes return. `toEqualTypeOf` fails `tsc` (and
 * so `npm run verify`) the moment either side changes without the other.
 */
describe("schemas mirror the payload interfaces exactly", () => {
  it("cannot drift from the TypeScript the routes return", () => {
    expectTypeOf<z.output<typeof S.InvoiceSchema>>().toEqualTypeOf<InvoicePayload>();
    expectTypeOf<z.output<typeof S.LedgerEntrySchema>>().toEqualTypeOf<LedgerEntryPayload>();
    expectTypeOf<z.output<typeof S.StatusSchema>>().toEqualTypeOf<StatusPayload>();
    expectTypeOf<z.output<typeof S.CounterpartySchema>>().toEqualTypeOf<CounterpartyPayload>();
    expectTypeOf<z.output<typeof S.CounterpartyDetailSchema>>().toEqualTypeOf<CounterpartyDetailPayload>();
    expectTypeOf<z.output<typeof S.ScreeningHistorySchema>>().toEqualTypeOf<ScreeningHistoryPayload>();
    expectTypeOf<z.output<typeof S.MilestoneSchema>>().toEqualTypeOf<MilestonePayload>();
    expectTypeOf<z.output<typeof S.TreasurySchema>>().toEqualTypeOf<TreasuryPayload>();
    expectTypeOf<z.output<typeof S.InsightsSchema>>().toEqualTypeOf<InsightsData>();
    expectTypeOf<z.output<typeof S.VerificationResultSchema>>().toEqualTypeOf<VerificationResult>();
  });

  it("covers each insights telemetry type and the envelope", () => {
    expectTypeOf<z.output<typeof S.TransferTelemetrySchema>>().toEqualTypeOf<TransferTelemetry>();
    expectTypeOf<z.output<typeof S.CycleRunTelemetrySchema>>().toEqualTypeOf<CycleRunTelemetry>();
    expectTypeOf<z.output<typeof S.CycleSnapshotTelemetrySchema>>().toEqualTypeOf<CycleSnapshotTelemetry>();
    expectTypeOf<z.output<typeof S.TreasuryMoveTelemetrySchema>>().toEqualTypeOf<TreasuryMoveTelemetry>();
    expectTypeOf<z.output<typeof S.ScreeningTelemetrySchema>>().toEqualTypeOf<ScreeningTelemetry>();
    expectTypeOf<z.output<typeof S.ApiErrorSchema>>().toEqualTypeOf<ApiError>();
    expectTypeOf<z.output<typeof S.ApiPageSchema>>().toEqualTypeOf<ApiPage>();
  });
});

describe("what an invoice's txHash is", () => {
  it("says a payout from a Gateway balance settles with the mint on the payee's chain, not on Arc (Gateway review M10)", () => {
    expect(S.InvoiceSchema.shape.txHash.description).toBe(
      "An on-chain hash once the payment settled, else null: on Arc testnet, or for a payout from a Gateway balance the mint on the payee's chain."
    );
  });
});

describe("every documented example is a real response of the current shape", () => {
  it.each(OPERATIONS.map((op) => [op.id, op] as const))("%s", (_id, op) => {
    expect(() => op.response.parse(op.example)).not.toThrow();
    // Parsing strips keys a schema does not know. An example that still
    // carries a field the payload has since dropped would parse, and then
    // document something the API no longer returns.
    expect(op.response.parse(op.example)).toEqual(op.example);
  });
});

describe("each write operation's request example", () => {
  it("is a body its route accepts, field for field (write API R2)", () => {
    const writes = OPERATIONS.filter((op) => op.method === "post");
    expect(writes.map((op) => op.id).sort()).toEqual(["create-counterparty", "create-invoice", "create-milestone", "create-payee-link"]);
    for (const op of writes) {
      expect(op.requestBody, op.id).toBeDefined();
      expect(op.requestBody!.parse(op.requestExample), op.id).toEqual(op.requestExample);
    }
  });
});

describe("a counterparty's address through the API (payment safety A1)", () => {
  const body = (address: string) => ({ name: "Quill Studio", role: "vendor", address, paymentLimit: "25" });

  it("accepts a checksummed address, and one in a single case", () => {
    for (const address of ["0x840de234Bfc3F66fA380888A0a8204D9487D60d4", "0x840de234bfc3f66fa380888a0a8204d9487d60d4"]) {
      expect(S.CreateCounterpartyBodySchema.safeParse(body(address)).success, address).toBe(true);
    }
  });

  it("refuses one whose capital letters do not match its checksum", () => {
    const result = S.CreateCounterpartyBodySchema.safeParse(body("0x840De234Bfc3F66fA380888A0a8204D9487D60d4"));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("This address's capital letters do not match its checksum, so a character is likely wrong.");
  });
});
