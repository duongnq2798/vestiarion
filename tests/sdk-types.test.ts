import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { renderSdkTypes, type OpenApiDoc } from "../scripts/lib/sdk-types";

/** The SDK's types are the OpenAPI document's (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R3). */

const doc = () => structuredClone(buildOpenApiDocument("https://www.vestiarion.xyz")) as unknown as OpenApiDoc;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into a JSON Schema to break it on purpose
const schemas = (d: OpenApiDoc) => d.components.schemas as Record<string, any>;

describe("sdk/src/types.ts", () => {
  it("is what the generator renders from the current OpenAPI document: run npm run sdk:types after an API change", () => {
    expect(readFileSync("sdk/src/types.ts", "utf8")).toBe(renderSdkTypes(doc()));
  });

  it("names each payload, keeps each field's description, and renders nulls, enums, records and the error codes", () => {
    const out = renderSdkTypes(doc());
    for (const name of ["Status", "LedgerEntry", "LedgerVerification", "Invoice", "Counterparty", "CounterpartyDetail", "Milestone", "Treasury", "Insights", "Page", "CreateInvoiceInput", "CreateCounterpartyInput", "ListInvoicesParams", "ListLedgerEntriesParams", "ListCounterpartiesParams", "ListMilestonesParams"]) {
      expect(out, name).toContain(`export interface ${name} {`);
    }
    expect(out).toContain('direction: "payable" | "receivable";');
    expect(out).toContain("/** Why the agent ruled as it did, verbatim from the decision. */");
    expect(out).toContain("memo: string | null;");
    expect(out).toMatch(/earlyPayDiscount: \{\n\s+percent: number;\n\s+deadline: string;\n\s+\} \| null;/);
    expect(out).toContain("detail: Record<string, unknown>;");
    expect(out).toContain('export const API_ERROR_CODES = ["unauthorized", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "unavailable", "internal"] as const;');
    expect(out).toMatch(/export interface ListInvoicesParams \{[\s\S]*?status\?: "pending" \| "matched"/);
    expect(out).toMatch(/export interface CreateInvoiceInput \{[\s\S]*?direction\?: "payable" \| "receivable";[\s\S]*?counterpartyId: string;/);
  });

  it("throws on a JSON Schema keyword it does not render, rather than guess a type", () => {
    const d = doc();
    schemas(d).GetStatusResponse.properties.data.properties.businessName.oneOf = [];
    expect(() => renderSdkTypes(d)).toThrow(/"oneOf" is not rendered/);
  });

  it("throws when a write's answer is not its list's item, so one name never hides two shapes", () => {
    const d = doc();
    schemas(d).CreateInvoiceResponse.properties.data.properties.extra = { type: "string" };
    expect(() => renderSdkTypes(d)).toThrow(/Invoice: CreateInvoiceResponse\.data differs/);
  });
});
