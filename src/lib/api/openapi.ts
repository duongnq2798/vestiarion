import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, STATUS_FOR, type ApiErrorCode } from "@/lib/api/contract";
import { COUNTERPARTY_RISK_LEVELS, COUNTERPARTY_ROLES } from "@/lib/api/counterparties";
import { INVOICE_DIRECTIONS, INVOICE_STATUSES } from "@/lib/api/invoices";
import { MILESTONE_STATUSES } from "@/lib/api/milestones";
import {
  ApiErrorSchema,
  collectionOf,
  CounterpartyDetailSchema,
  CounterpartySchema,
  InsightsSchema,
  InvoiceSchema,
  LedgerEntrySchema,
  MilestoneSchema,
  resourceOf,
  StatusSchema,
  TreasurySchema,
  VerificationResultSchema,
} from "@/lib/api/schemas";
import getCounterpartyExample from "../../../content/docs/examples/get-counterparty.json";
import getInsightsExample from "../../../content/docs/examples/get-insights.json";
import getStatusExample from "../../../content/docs/examples/get-status.json";
import getTreasuryExample from "../../../content/docs/examples/get-treasury.json";
import listCounterpartiesExample from "../../../content/docs/examples/list-counterparties.json";
import listInvoicesExample from "../../../content/docs/examples/list-invoices.json";
import listLedgerEntriesExample from "../../../content/docs/examples/list-ledger-entries.json";
import listMilestonesExample from "../../../content/docs/examples/list-milestones.json";
import verifyLedgerExample from "../../../content/docs/examples/verify-ledger.json";

/**
 * The `/api/v1` surface as data: one entry per route, from which the OpenAPI
 * document, the reference pages and the code samples are all built.
 *
 * Parameters, enums and defaults are taken from the route code and import its
 * constants, so a new filter value reaches the docs without a second edit.
 * `tests/openapi.test.ts` checks that every route file has exactly one entry
 * here, and that each route's real response parses against its schema.
 */

export interface DocParam {
  name: string;
  in: "query" | "path";
  required: boolean;
  type: "string" | "integer";
  description: string;
  enum?: readonly string[];
  default?: string | number;
  minimum?: number;
  maximum?: number;
  example?: string | number;
}

export interface DocOperation {
  id: string;
  method: "get";
  path: string;
  summary: string;
  description: string;
  tag: "Workspace" | "Ledger" | "Payables and receivables" | "Counterparties" | "Milestones" | "Treasury" | "Insights";
  params: DocParam[];
  response: z.ZodType;
  collection: boolean;
  errors: ApiErrorCode[];
  example: unknown;
}

const PAGE_PARAMS: DocParam[] = [
  {
    name: "limit",
    in: "query",
    required: false,
    type: "integer",
    description: `How many items to return. Defaults to ${DEFAULT_PAGE_SIZE}; a larger value is capped at ${MAX_PAGE_SIZE}.`,
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    type: "string",
    description:
      "The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this API did not issue is refused with `400`.",
  },
];

/** Every route authenticates, and can fail to. */
const ALWAYS: ApiErrorCode[] = ["unauthorized", "forbidden", "internal"];
/** A collection also refuses a bad `limit`, `cursor` or filter value. */
const COLLECTION_ERRORS: ApiErrorCode[] = ["invalid_request", ...ALWAYS];

export const OPERATIONS: readonly DocOperation[] = [
  {
    id: "get-status",
    method: "get",
    path: "/api/v1/status",
    summary: "Get workspace status",
    description:
      "What this workspace is, and what it can actually do. The first call a client should make: whether payments and yield are live, simulated or unavailable, the workspace clock, running totals, and a description of its configuration. Secrets are never included.\n\n`unavailable` means the workspace's Circle credentials are stored but cannot be read. A cycle refuses to pay in that state rather than fall back to simulation, so status does not report it as `simulate`.",
    tag: "Workspace",
    params: [],
    response: resourceOf(StatusSchema),
    collection: false,
    errors: ALWAYS,
    example: getStatusExample,
  },
  {
    id: "list-ledger-entries",
    method: "get",
    path: "/api/v1/ledger",
    summary: "List ledger entries",
    description:
      "The audit chain, oldest first, as a resumable stream. Because the ledger is append-only and ascending by `seq`, a stored `page.nextCursor` is a watermark: later entries are returned once, and earlier entries are not replayed. Persist the cursor only after processing every entry in the response.\n\n`seq` is monotonic within a workspace but not gap-free; continuity is proven by the hash chain, not by `seq`.",
    tag: "Ledger",
    params: [
      ...PAGE_PARAMS,
      { name: "domain", in: "query", required: false, type: "string", description: "Only entries in this domain.", example: "system" },
      { name: "actor", in: "query", required: false, type: "string", description: "Only entries written by this actor.", example: "system" },
    ],
    response: collectionOf(LedgerEntrySchema),
    collection: true,
    errors: COLLECTION_ERRORS,
    example: listLedgerEntriesExample,
  },
  {
    id: "verify-ledger",
    method: "get",
    path: "/api/v1/ledger/verify",
    summary: "Verify the ledger",
    description:
      "Replays signatures, body hashes and hash-chain continuity for the workspace the calling key belongs to.\n\n`valid` has three values, not two. `true` verified and `false` broken are findings about the chain; `null` means no verdict was produced, because there was no key to check authorship against. `reason` says which case it is. A key that is stored but cannot be read is a configuration problem, reported in `warnings`, not a finding about the chain.",
    tag: "Ledger",
    params: [],
    response: resourceOf(VerificationResultSchema),
    collection: false,
    errors: ALWAYS,
    example: verifyLedgerExample,
  },
  {
    id: "list-invoices",
    method: "get",
    path: "/api/v1/invoices",
    summary: "List invoices",
    description:
      "The payable and receivable book, newest first, with the row id breaking equal timestamps. Each invoice carries the agent's reasoning, not only its verdict. Only a transaction reference beginning with `0x` is exposed as `txHash`; a simulated receipt gives `null`.\n\nAn unknown `direction` or `status` is refused with `400` rather than ignored.",
    tag: "Payables and receivables",
    params: [
      ...PAGE_PARAMS,
      { name: "direction", in: "query", required: false, type: "string", description: "Only payables, or only receivables.", enum: INVOICE_DIRECTIONS },
      { name: "status", in: "query", required: false, type: "string", description: "Only invoices in this status.", enum: INVOICE_STATUSES },
      {
        name: "counterpartyId",
        in: "query",
        required: false,
        type: "string",
        description: "Only invoices from or to this counterparty.",
        example: "4e363b59-d1ca-4425-924c-5c894bc3373f",
      },
    ],
    response: collectionOf(InvoiceSchema),
    collection: true,
    errors: COLLECTION_ERRORS,
    example: listInvoicesExample,
  },
  {
    id: "list-counterparties",
    method: "get",
    path: "/api/v1/counterparties",
    summary: "List counterparties",
    description:
      "Vendors, clients and contractors, newest first, with the row id breaking equal timestamps. Both the business's baseline payment limit and the current limit derived from the risk tier are reported. `performanceScore` is `null` when there is no history.",
    tag: "Counterparties",
    params: [
      ...PAGE_PARAMS,
      { name: "role", in: "query", required: false, type: "string", description: "Only counterparties with this role.", enum: COUNTERPARTY_ROLES },
      { name: "riskLevel", in: "query", required: false, type: "string", description: "Only counterparties at this risk tier.", enum: COUNTERPARTY_RISK_LEVELS },
    ],
    response: collectionOf(CounterpartySchema),
    collection: true,
    errors: COLLECTION_ERRORS,
    example: listCounterpartiesExample,
  },
  {
    id: "get-counterparty",
    method: "get",
    path: "/api/v1/counterparties/{id}",
    summary: "Get a counterparty",
    description:
      "One counterparty, with up to 20 recent compliance screenings, newest first. An id this workspace does not hold, including another workspace's, answers `404`.",
    tag: "Counterparties",
    params: [
      {
        name: "id",
        in: "path",
        required: true,
        type: "string",
        description: "The counterparty's id.",
        example: "dc5e5751-3287-46c9-8bd1-83a42ab02699",
      },
    ],
    response: resourceOf(CounterpartyDetailSchema),
    collection: false,
    errors: ["unauthorized", "forbidden", "not_found", "internal"],
    example: getCounterpartyExample,
  },
  {
    id: "list-milestones",
    method: "get",
    path: "/api/v1/milestones",
    summary: "List milestones",
    description:
      "Contractor milestones, newest first, with the row id breaking equal timestamps: how each was verified, and whether it was paid. Only a real `0x` transaction is exposed as `txHash`.",
    tag: "Milestones",
    params: [
      ...PAGE_PARAMS,
      { name: "status", in: "query", required: false, type: "string", description: "Only milestones in this status.", enum: MILESTONE_STATUSES },
      {
        name: "contractorId",
        in: "query",
        required: false,
        type: "string",
        description: "Only milestones for this contractor.",
        example: "5541f1a4-4e48-4fa5-880c-9ffc97d8953b",
      },
    ],
    response: collectionOf(MilestoneSchema),
    collection: true,
    errors: COLLECTION_ERRORS,
    example: listMilestonesExample,
  },
  {
    id: "get-treasury",
    method: "get",
    path: "/api/v1/treasury",
    summary: "Get the treasury",
    description:
      "The workspace's accounts and reserve position, its obligations from the latest cycle snapshot, the latest liquidity forecast, and up to 20 recent treasury moves. Obligations stay `null` before any snapshot exists; the API does not invent zeroes.",
    tag: "Treasury",
    params: [],
    response: resourceOf(TreasurySchema),
    collection: false,
    errors: ALWAYS,
    example: getTreasuryExample,
  },
  {
    id: "get-insights",
    method: "get",
    path: "/api/v1/insights",
    summary: "Get insights",
    description:
      "The telemetry behind the Insights page: recent transfers, cycle runs, cycle snapshots, treasury moves and screenings. `referenceDisagreementCount: null` means the cycle predates the comparison, and `status: \"partial\"` is reported as it is, not rewritten as completed or failed.",
    tag: "Insights",
    params: [],
    response: resourceOf(InsightsSchema),
    collection: false,
    errors: ALWAYS,
    example: getInsightsExample,
  },
];

export function operationById(id: string): DocOperation | undefined {
  return OPERATIONS.find((op) => op.id === id);
}

/** `get-status` → `GetStatusResponse`. */
function schemaName(id: string): string {
  return `${id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Response`;
}

/**
 * A schema as it sits under `components.schemas`: JSON Schema 2020-12, which
 * OpenAPI 3.1 uses, without its own `$schema`. The reference pages build their
 * response trees from this too, so a page and the document cannot disagree.
 */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `io: "input"` leaves objects open (no `additionalProperties: false`): a
  // field added to v1 later must not break a client that validates responses
  // against this document. No schema here transforms, so the shapes are equal.
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function buildOpenApiDocument(origin: string): Record<string, unknown> {
  const components: Record<string, unknown> = { ApiError: jsonSchema(ApiErrorSchema) };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const name = schemaName(op.id);
    components[name] = jsonSchema(op.response);
    const responses: Record<string, unknown> = {
      "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` }, example: op.example } } },
    };
    for (const code of op.errors) {
      responses[String(STATUS_FOR[code])] = { description: code, content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
    }
    (paths[op.path] ??= {})[op.method] = {
      operationId: op.id,
      summary: op.summary,
      description: op.description,
      tags: [op.tag],
      security: [{ bearerAuth: [] }],
      parameters: op.params.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        description: p.description,
        schema: {
          type: p.type,
          ...(p.enum && { enum: p.enum }),
          ...(p.default !== undefined && { default: p.default }),
          ...(p.minimum !== undefined && { minimum: p.minimum }),
          ...(p.maximum !== undefined && { maximum: p.maximum }),
        },
        ...(p.example !== undefined && { example: p.example }),
      })),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Vestiarion API", version: "v1", description: "Read a workspace's ledger, books, counterparties, milestones, treasury and insights with a workspace API key." },
    servers: [{ url: origin }],
    components: { schemas: components, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "A workspace API key: vxk_<prefix>_<secret>." } } },
    paths,
  };
}
