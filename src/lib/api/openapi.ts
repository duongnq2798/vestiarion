import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, STATUS_FOR, type ApiErrorCode } from "@/lib/api/contract";
import { COUNTERPARTY_RISK_LEVELS, COUNTERPARTY_ROLES } from "@/lib/api/counterparties";
import { INVOICE_DIRECTIONS, INVOICE_STATUSES } from "@/lib/api/invoices";
import { MILESTONE_STATUSES } from "@/lib/api/milestones";
import {
  ApiErrorSchema,
  ClosePackSchema,
  collectionOf,
  CounterpartyDetailSchema,
  CreateCounterpartyBodySchema,
  CreateInvoiceBodySchema,
  CreateMilestoneBodySchema,
  CreatePayeeLinkBodySchema,
  CounterpartySchema,
  InsightsSchema,
  InvoiceSchema,
  LedgerEntrySchema,
  MilestoneSchema,
  PayeeLinkSchema,
  PayeeLockEvidenceSchema,
  PaymentEvidenceSchema,
  PaymentReceiptSchema,
  resourceOf,
  StatusSchema,
  TreasurySchema,
  VerificationResultSchema,
} from "@/lib/api/schemas";
import createCounterpartyExample from "../../../content/docs/examples/create-counterparty.json";
import createInvoiceExample from "../../../content/docs/examples/create-invoice.json";
import createMilestoneExample from "../../../content/docs/examples/create-milestone.json";
import createPayeeLinkExample from "../../../content/docs/examples/create-payee-link.json";
import getClosePackExample from "../../../content/docs/examples/get-close-pack.json";
import getCounterpartyExample from "../../../content/docs/examples/get-counterparty.json";
import getInsightsExample from "../../../content/docs/examples/get-insights.json";
import getInvoiceEvidenceExample from "../../../content/docs/examples/get-invoice-evidence.json";
import getInvoiceReceiptExample from "../../../content/docs/examples/get-invoice-receipt.json";
import getMilestoneEvidenceExample from "../../../content/docs/examples/get-milestone-evidence.json";
import getPayeeLockEvidenceExample from "../../../content/docs/examples/get-payee-lock-evidence.json";
import getStatusExample from "../../../content/docs/examples/get-status.json";
import getTreasuryExample from "../../../content/docs/examples/get-treasury.json";
import listCounterpartiesExample from "../../../content/docs/examples/list-counterparties.json";
import listInvoicesExample from "../../../content/docs/examples/list-invoices.json";
import listLedgerEntriesExample from "../../../content/docs/examples/list-ledger-entries.json";
import listMilestonesExample from "../../../content/docs/examples/list-milestones.json";
import verifyLedgerExample from "../../../content/docs/examples/verify-ledger.json";

/**
 * The `/api/v1` surface as data: one entry per route and method, from which
 * the OpenAPI document, the reference pages, the code samples and the MCP
 * tools are all built.
 *
 * Parameters, enums and defaults are taken from the route code and import its
 * constants, so a new filter value reaches the docs without a second edit.
 * `tests/openapi.test.ts` checks that every handler a route file exports has
 * exactly one entry here, and that each route's real response parses against
 * its schema.
 */

export interface DocParam {
  name: string;
  /** A header parameter is sent as a header, and an MCP tool takes it as a camelCase argument. */
  in: "query" | "path" | "header";
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
  method: "get" | "post";
  path: string;
  summary: string;
  description: string;
  tag: "Workspace" | "Ledger" | "Payables and receivables" | "Counterparties" | "Milestones" | "Treasury" | "Insights" | "Evidence";
  /** What a key needs to call it: `read`, or `write` for an operation that adds records (write API R1). */
  scope: "read" | "write";
  params: DocParam[];
  /** The JSON body a write takes, which its route checks first. */
  requestBody?: z.ZodObject;
  /** The body the samples send, which the body schema accepts as it is. */
  requestExample?: Record<string, unknown>;
  /** What a success answers: 200, or 201 when the operation added a record. */
  status: 200 | 201;
  /**
   * A write that can undo something already there, as making a payee link revokes the payee's unused one (write API
   * part 2, W3). Its MCP tool says so.
   */
  destructive?: true;
  response: z.ZodType;
  collection: boolean;
  errors: ApiErrorCode[];
  example: unknown;
  /**
   * No MCP tool yet (evidence API EA9): a tool's answer goes into a model's context whole, and these carry every entry in
   * full and text from outside. Their tools are designed with their own answers and handling, then this flag goes.
   */
  mcp?: false;
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
      "The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`.",
  },
];

/** Every route authenticates, and can fail to. */
const ALWAYS: ApiErrorCode[] = ["unauthorized", "forbidden", "internal"];
/** A collection also refuses a bad `limit`, `cursor` or filter value. */
const COLLECTION_ERRORS: ApiErrorCode[] = ["invalid_request", ...ALWAYS];
/** A write also refuses a body that does not validate, a reused `Idempotency-Key`, and too many writes (write API R5–R7). */
const WRITE_ERRORS: ApiErrorCode[] = ["invalid_request", "unauthorized", "forbidden", "conflict", "rate_limited", "internal"];
/** A write that keeps no outcome for an `Idempotency-Key` cannot conflict over one (write API part 2, W3). */
const WRITE_ERRORS_WITHOUT_KEY: ApiErrorCode[] = WRITE_ERRORS.filter((code) => code !== "conflict");

/** An evidence read of one record also answers a record it does not hold, and the brake shared by the five (evidence API EA5, EA6). */
const EVIDENCE_RECORD_ERRORS: ApiErrorCode[] = ["unauthorized", "forbidden", "not_found", "rate_limited", "internal"];
/** A period's evidence read also refuses a month or a day that does not read, and an answer over 4 MB (EA5, EA7). */
const EVIDENCE_PERIOD_ERRORS: ApiErrorCode[] = ["invalid_request", "unauthorized", "forbidden", "rate_limited", "internal"];
/** The made-up workspace's payable and milestone the evidence examples are of (EA11). */
const EXAMPLE_PAYABLE = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51";
const EXAMPLE_MILESTONE = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4f61";

/** The contractor the write examples pay: the one the testnet-2 check added (write API part 2, §5). */
const EXAMPLE_CONTRACTOR = "26d6ffed-356d-474a-8d42-89bc942f6b4e";

/** The header that makes a write safe to retry (write API R5), with an example of the kind of value to send. */
function idempotencyKey(example: string): DocParam {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: false,
    type: "string",
    description:
      "Makes a retry safe: up to 255 printable ASCII characters, unique to the record being added, such as its id in your own system. A repeat with the same key and the same body within 24 hours gets the first answer back, with `Idempotent-Replayed: true`, and adds nothing. The same key with a different body answers `409`.",
    example,
  };
}

/**
 * Every `/api/v1` operation, as the docs and `/api/v1/openapi.json` describe it.
 * A route's query parameters are documented only here: the route handlers read
 * them from the URL themselves, and nothing derives this list from that code.
 * A route that accepts a new query parameter must add it to its `params` here
 * too, or the reference page, "Try it", the Markdown view and the OpenAPI
 * document will not know it exists.
 */
export const OPERATIONS: readonly DocOperation[] = [
  {
    id: "get-status",
    method: "get",
    path: "/api/v1/status",
    summary: "Get workspace status",
    description:
      "What this workspace is, and what it can actually do. The first call a client should make: whether payments and yield are live, simulated or unavailable, the workspace clock, running totals, and a description of its configuration. Secrets are never included.\n\n`unavailable` means nothing can pay in this workspace now: its Circle credentials are stored but cannot be read; or it is on Arc mainnet with no Circle account connected yet, or not live yet; or this deployment has Arc mainnet switched off. A cycle refuses to pay then rather than fall back to simulation, so status does not report it as `simulate`. Yield is also `unavailable` on a network with no yield reserve, such as Arc mainnet.",
    tag: "Workspace",
    scope: "read",
    params: [],
    status: 200,
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
      "The audit chain, oldest first, as a resumable stream. Because the ledger is append-only and ascending by `seq`, a stored `page.nextCursor` is a watermark: a request from it never returns an entry before it. Persist the last non-null `nextCursor` only after processing every entry in the responses read, and resume from it; the last page, which had no cursor of its own, is returned again, so de-duplicate on `seq`.\n\n`seq` is monotonic within a workspace but not gap-free; continuity is proven by the hash chain, not by `seq`.",
    tag: "Ledger",
    scope: "read",
    params: [
      ...PAGE_PARAMS,
      { name: "domain", in: "query", required: false, type: "string", description: "Only entries in this domain.", example: "system" },
      { name: "actor", in: "query", required: false, type: "string", description: "Only entries written by this actor.", example: "system" },
    ],
    status: 200,
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
    scope: "read",
    params: [],
    status: 200,
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
    scope: "read",
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
    status: 200,
    response: collectionOf(InvoiceSchema),
    collection: true,
    errors: COLLECTION_ERRORS,
    example: listInvoicesExample,
  },
  {
    id: "create-invoice",
    method: "post",
    path: "/api/v1/invoices",
    summary: "Add an invoice",
    description:
      "Adds a payable or a receivable, checked by the rules of the console's invoice form, and recorded in the ledger as `create_invoice` with `via: \"api\"` and the key's id. It is added as the key's issuer's: if the agent holds it, the issuer cannot approve it, unless they are the workspace's only approver.\n\nThe agent decides a payable as one typed in, with every guardrail and the workspace's limits, usually within a minute. The API never approves or pays. A `counterpartyId` the workspace does not hold, including another workspace's, answers `400`.",
    tag: "Payables and receivables",
    scope: "write",
    params: [idempotencyKey("billing-inv-2026-0042")],
    requestBody: CreateInvoiceBodySchema,
    requestExample: {
      counterpartyId: "6b361405-cfda-4400-a286-364b561911ce",
      amount: "0.10",
      dueDate: "2026-10-03",
      poReference: "PO-API-1",
      goodsReceived: true,
    },
    status: 201,
    response: resourceOf(InvoiceSchema),
    collection: false,
    errors: WRITE_ERRORS,
    example: createInvoiceExample,
  },
  {
    id: "list-counterparties",
    method: "get",
    path: "/api/v1/counterparties",
    summary: "List counterparties",
    description:
      "Vendors, clients and contractors, newest first, with the row id breaking equal timestamps. Both the business's baseline payment limit and the current limit derived from the risk tier are reported. `performanceScore` is `null` when there is no history.",
    tag: "Counterparties",
    scope: "read",
    params: [
      ...PAGE_PARAMS,
      { name: "role", in: "query", required: false, type: "string", description: "Only counterparties with this role.", enum: COUNTERPARTY_ROLES },
      { name: "riskLevel", in: "query", required: false, type: "string", description: "Only counterparties at this risk tier.", enum: COUNTERPARTY_RISK_LEVELS },
    ],
    status: 200,
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
    scope: "read",
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
    status: 200,
    response: resourceOf(CounterpartyDetailSchema),
    collection: false,
    errors: ["unauthorized", "forbidden", "not_found", "internal"],
    example: getCounterpartyExample,
  },
  {
    id: "create-counterparty",
    method: "post",
    path: "/api/v1/counterparties",
    summary: "Add a counterparty",
    description:
      "Adds a vendor, contractor or client, checked by the rules of the console's form and screened as one added there: the answer's `riskLevel` is the screening's verdict, or `unscreened` when screening could not finish. It is recorded in the ledger as `create_counterparty` with `via: \"api\"` and the key's id.\n\nAn address added through the API waits for a person. The agent pays nothing to it until an owner, admin or approver confirms it on Counterparties, so a key can add records but cannot point the agent's payments at a new address.",
    tag: "Counterparties",
    scope: "write",
    params: [idempotencyKey("crm-vendor-1042")],
    requestBody: CreateCounterpartyBodySchema,
    requestExample: {
      name: "API Test Vendor",
      role: "vendor",
      address: "0x6b3A4C65f362b818bb7FD6f999477A03CE07e51a",
      paymentLimit: "1",
    },
    status: 201,
    response: resourceOf(CounterpartySchema),
    collection: false,
    errors: WRITE_ERRORS,
    example: createCounterpartyExample,
  },
  {
    id: "create-payee-link",
    method: "post",
    path: "/api/v1/payee-links",
    summary: "Create a payee link",
    description:
      "Makes a one-time link where a vendor or contractor enters the address they are paid at, recorded in the ledger as `payee_link_created` with `via: \"api\"` and the key's id. Send `url` to the payee yourself. It is in this answer only, since Vestiarion keeps just its hash, and the answer is sent with `Cache-Control: no-store`. The link works once and expires after 7 days.\n\nThe address the payee enters waits for a person in the workspace to confirm it on Counterparties; until then the agent pays nothing to it. Making a link revokes the payee's unused one, so only the newest works. For the same reason this operation keeps no outcome for an `Idempotency-Key`, which would store the link: a repeat makes a new link. A `counterpartyId` the workspace does not hold, or a client's, answers `400`.",
    tag: "Counterparties",
    scope: "write",
    params: [],
    requestBody: CreatePayeeLinkBodySchema,
    requestExample: { counterpartyId: EXAMPLE_CONTRACTOR },
    status: 201,
    destructive: true,
    response: resourceOf(PayeeLinkSchema),
    collection: false,
    errors: WRITE_ERRORS_WITHOUT_KEY,
    example: createPayeeLinkExample,
  },
  {
    id: "list-milestones",
    method: "get",
    path: "/api/v1/milestones",
    summary: "List milestones",
    description:
      "Contractor milestones, newest first, with the row id breaking equal timestamps: how each was verified, and whether it was paid. Only a real `0x` transaction is exposed as `txHash`.",
    tag: "Milestones",
    scope: "read",
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
    status: 200,
    response: collectionOf(MilestoneSchema),
    collection: true,
    errors: COLLECTION_ERRORS,
    example: listMilestonesExample,
  },
  {
    id: "create-milestone",
    method: "post",
    path: "/api/v1/milestones",
    summary: "Add a milestone",
    description:
      "Adds work a contractor is to be paid for, checked by the rules of the console's Add milestone form, and recorded in the ledger as `create_milestone` with `via: \"api\"` and the key's id. It is added as the key's issuer's: if the agent holds it on its own judgment, someone other than the issuer must choose Pay now, unless the issuer is the workspace's only approver.\n\nIt starts `pending`, and the API cannot verify it. A GitHub pull request in `verificationSource` is checked by the agent, which verifies the milestone once the pull request is merged; any other link is evidence for the person who verifies it on Contractors. Once it is verified, the agent decides the payment with every guardrail, and pays only to the contractor's confirmed address. A `contractorId` the workspace does not hold, or a client's, answers `400`.",
    tag: "Milestones",
    scope: "write",
    params: [idempotencyKey("ci-bounty-pr-176")],
    requestBody: CreateMilestoneBodySchema,
    requestExample: {
      contractorId: EXAMPLE_CONTRACTOR,
      title: "TypeScript SDK for the API",
      amount: "0.10",
      verificationSource: "https://github.com/duongnq2798/vestiarion/pull/176",
    },
    status: 201,
    response: resourceOf(MilestoneSchema),
    collection: false,
    errors: WRITE_ERRORS,
    example: createMilestoneExample,
  },
  {
    id: "get-treasury",
    method: "get",
    path: "/api/v1/treasury",
    summary: "Get the treasury",
    description:
      "The workspace's accounts and reserve position, its obligations from the latest cycle snapshot, the latest liquidity forecast, and up to 20 recent treasury moves. Obligations stay `null` before any snapshot exists; the API does not invent zeroes.",
    tag: "Treasury",
    scope: "read",
    params: [],
    status: 200,
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
    scope: "read",
    params: [],
    status: 200,
    response: resourceOf(InsightsSchema),
    collection: false,
    errors: ALWAYS,
    example: getInsightsExample,
  },
  // The evidence reads (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA1): the
  // workspace's signed files, each as its page downloads it, with members named by user id. One brake per key for the
  // five (EA6); no MCP tool yet (EA9). Their examples are built by scripts/evidence-examples.ts, not recorded (EA11).
  {
    id: "get-invoice-evidence",
    method: "get",
    path: "/api/v1/invoices/{id}/evidence",
    summary: "Get a payable's evidence",
    description:
      "Why a payable was paid, or why it is not paid yet, as one signed document: the evidence chain its evidence page shows, from what was agreed to the signatures. Each fact is labelled by how it is known and cites the ledger entries it rests on, and every one of those entries is carried in full with the workspace's public keys, so each can be checked offline with the SDK's `verifyEvidence`. It is the file the page's Download evidence gives, in the format `vestiarion-evidence/1`, with members named by user id, never by email.\n\nA receivable, or an id this workspace does not hold, including another workspace's, answers `404`. Each call reads the transaction on its chain and checks the links people gave, so the evidence reads have a limit of their own per key. Text that came from outside, such as a vendor's name, an invoice number or a memo, is carried as data.",
    tag: "Evidence",
    scope: "read",
    params: [{ name: "id", in: "path", required: true, type: "string", description: "The payable's id, as `GET /api/v1/invoices` lists it.", example: EXAMPLE_PAYABLE }],
    status: 200,
    response: resourceOf(PaymentEvidenceSchema),
    collection: false,
    errors: EVIDENCE_RECORD_ERRORS,
    example: getInvoiceEvidenceExample,
    mcp: false,
  },
  {
    id: "get-milestone-evidence",
    method: "get",
    path: "/api/v1/milestones/{id}/evidence",
    summary: "Get a milestone's evidence",
    description:
      "Why a contractor's milestone was paid, or why it is not paid yet, as one signed document: what was agreed, what was delivered and how it was verified, who decided, and the payment, each fact citing the ledger entries it rests on, which the document carries in full with the workspace's public keys. The format is a payable's, `vestiarion-evidence/1`, with members named by user id.\n\nAn id this workspace does not hold, including another workspace's, answers `404`. Text that came from outside, such as a pull request's title or a contractor's name, is carried as data.",
    tag: "Evidence",
    scope: "read",
    params: [{ name: "id", in: "path", required: true, type: "string", description: "The milestone's id, as `GET /api/v1/milestones` lists it.", example: EXAMPLE_MILESTONE }],
    status: 200,
    response: resourceOf(PaymentEvidenceSchema),
    collection: false,
    errors: EVIDENCE_RECORD_ERRORS,
    example: getMilestoneEvidenceExample,
    mcp: false,
  },
  {
    id: "get-invoice-receipt",
    method: "get",
    path: "/api/v1/invoices/{id}/receipt",
    summary: "Get a payable's receipt",
    description:
      "What a receipt states for a paid payable, in the format `vestiarion-receipt/1`: the amount and token, when it was paid, the address paid and its chain, the transaction, its route and fee, the vendor's invoice number, and what an early-payment discount took off; the ledger entry that recorded the transaction; and two checks, of that entry's signature and of the transaction on the payee's chain. When a member has shared the receipt, `shared` says when, names the `receipt_shared` entry that signed its statement, and says whether its link opens now. The link is never in the answer: Vestiarion keeps only its hash.\n\nA payable with no receipt yet answers `200` with `ready: false` and a `notReady` code: `not_paid`; `simulated`, a sandbox's payment, which moves nothing on chain; `not_minted`, a payout to another chain whose mint is not recorded yet; `no_transaction`; or `not_recorded`. A receivable, or an id this workspace does not hold, answers `404`. Text that came from outside, such as a vendor's name or an invoice number, is carried as data.",
    tag: "Evidence",
    scope: "read",
    params: [{ name: "id", in: "path", required: true, type: "string", description: "The payable's id, as `GET /api/v1/invoices` lists it.", example: EXAMPLE_PAYABLE }],
    status: 200,
    response: resourceOf(PaymentReceiptSchema),
    collection: false,
    errors: EVIDENCE_RECORD_ERRORS,
    example: getInvoiceReceiptExample,
    mcp: false,
  },
  {
    id: "get-payee-lock-evidence",
    method: "get",
    path: "/api/v1/payee-lock/evidence",
    summary: "Get the payee lock's evidence",
    description:
      "Every payout address change in a period, in the format `vestiarion-payee-lock-evidence/1`: who entered it, how it was checked and by whom, whether a second person stood behind it, what it held back, and the first payment to it, each fact citing the signed entries it rests on, which the document carries in full with the workspace's public keys. It is the file the evidence pack's Download signed JSON gives, with members named by user id, never by email.\n\nDays are whole UTC days; leave out `from` or `to` for an open end. A day that does not read, or a `from` after `to`, answers `400`, as does a period whose answer would be over 4 MB: ask for a shorter one. Text that came from outside, such as a payee's name, is carried as data.",
    tag: "Evidence",
    scope: "read",
    params: [
      { name: "from", in: "query", required: false, type: "string", description: "The first day, as `YYYY-MM-DD`, in UTC. Leave it out to start from the first change.", example: "2026-10-01" },
      { name: "to", in: "query", required: false, type: "string", description: "The last day, included, as `YYYY-MM-DD`, in UTC. Leave it out to run to now.", example: "2026-10-31" },
    ],
    status: 200,
    response: resourceOf(PayeeLockEvidenceSchema),
    collection: false,
    errors: EVIDENCE_PERIOD_ERRORS,
    example: getPayeeLockEvidenceExample,
    mcp: false,
  },
  {
    id: "get-close-pack",
    method: "get",
    path: "/api/v1/close-packs/{month}",
    summary: "Get a monthly close pack",
    description:
      "Every payment settled in a calendar month (UTC), one row each: the bill with its invoice number and its document's SHA-256, who decided and approved it, what was checked, the transaction, the books, and the signed entry that records it; then the payments not settled in the month and the escrow moves, apart, totals per token, and every cited entry in full with the workspace's public keys. The format is `vestiarion-close-pack/1`, the file the Monthly close pack page's Download signed JSON gives, with members named by user id.\n\n`month` is `YYYY-MM`. This month is allowed, and reads so far: `month.ended` is `false`. A month still to come, or one before 2020, answers `400`, as does a month whose answer would be over 4 MB: download that one from the workspace. A month of more than 2,000 payments is cut at 2,000 and says so in `cut`. Reading it records nothing in the ledger. Text that came from outside, such as a vendor's name, an invoice number or a memo, is carried as data.",
    tag: "Evidence",
    scope: "read",
    params: [{ name: "month", in: "path", required: true, type: "string", description: "The month, as `YYYY-MM`: a calendar month in UTC.", example: "2026-10" }],
    status: 200,
    response: resourceOf(ClosePackSchema),
    collection: false,
    errors: EVIDENCE_PERIOD_ERRORS,
    example: getClosePackExample,
    mcp: false,
  },
];

export function operationById(id: string): DocOperation | undefined {
  return OPERATIONS.find((op) => op.id === id);
}

/** `get-status` → `GetStatusResponse`; a write's body, `create-invoice` → `CreateInvoiceRequest`. */
function schemaName(id: string, kind: "Request" | "Response" = "Response"): string {
  return `${id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}${kind}`;
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
  // A request body is strict, so its schema stays closed: the route refuses a
  // field it does not take rather than dropping it.
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
      [String(op.status)]: {
        description: op.status === 201 ? "Created" : "OK",
        content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` }, example: op.example } },
      },
    };
    let requestBody: Record<string, unknown> | undefined;
    if (op.requestBody) {
      const bodyName = schemaName(op.id, "Request");
      components[bodyName] = jsonSchema(op.requestBody);
      requestBody = {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${bodyName}` }, example: op.requestExample } },
      };
    }
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
      ...(requestBody && { requestBody }),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Vestiarion API", version: "v1", description: "Read a workspace's ledger, books, counterparties, milestones, treasury and insights, each payment's evidence and receipt and the monthly close pack, and add counterparties, invoices, milestones and payee links, with a workspace API key." },
    servers: [{ url: origin }],
    components: { schemas: components, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "A workspace API key: vxk_<prefix>_<secret>." } } },
    paths,
  };
}
