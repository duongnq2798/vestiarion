import { VestiarionError } from "./errors.js";
import { createTransport, type FetchLike, type Transport } from "./http.js";
import type {
  ClosePack,
  Counterparty,
  CounterpartyDetail,
  CreateCounterpartyInput,
  CreateInvoiceInput,
  CreateMilestoneInput,
  CreatePayeeLinkInput,
  GetPayeeLockEvidenceParams,
  Insights,
  Invoice,
  LedgerEntry,
  LedgerVerification,
  ListCounterpartiesParams,
  ListInvoicesParams,
  ListLedgerEntriesParams,
  ListMilestonesParams,
  Milestone,
  Page,
  PayeeLink,
  PayeeLockEvidence,
  PaymentEvidence,
  PaymentReceipt,
  Status,
  Treasury,
} from "./types.js";

/** Where the API is, unless `baseUrl` says otherwise. */
export const DEFAULT_BASE_URL = "https://www.vestiarion.xyz";

export interface VestiarionOptions {
  /** A workspace API key, `vxk_<prefix>_<secret>`. Keep it on a server: it reads the whole workspace. */
  apiKey: string;
  /** Where the API is. Defaults to `https://www.vestiarion.xyz`. Plain `http` is refused, except to localhost. */
  baseUrl?: string;
  /** Defaults to the runtime's `fetch`. */
  fetch?: FetchLike;
  /** How many times a request is retried after a 429, a 5xx, a timeout or a network failure. Defaults to 2. */
  maxRetries?: number;
  /** How long one attempt may take, in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

/** One page of a collection, as the API answers it. */
export interface List<T> {
  data: T[];
  page: Page;
}

/** A write's options: the `Idempotency-Key` that makes retrying it safe. Best: the record's id in your own system. */
export interface WriteOptions {
  idempotencyKey?: string;
}

export interface Collection<T, P> {
  /** One page, `{ data, page }`. Pass `page.nextCursor` back as `cursor` for the next. */
  list(params?: P): Promise<List<T>>;
  /** Every page in turn, from `params.cursor` on. Store each `page.nextCursor` once its page is processed, to resume from it. */
  pages(params?: P): AsyncIterable<List<T>>;
  /** Every item, page after page, until the collection ends. */
  listAll(params?: P): AsyncIterable<T>;
}

const KEY_FORMAT = /^vxk_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An https URL, or plain http to this machine for local testing: the key must never travel in the clear. */
function isSafeBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

function collection<T, P extends { cursor?: string }>(transport: Transport, path: string): Collection<T, P> {
  const list = (params?: P) => transport.request<List<T>>({ method: "GET", path, query: params });
  async function* pages(params?: P): AsyncGenerator<List<T>> {
    let cursor = params?.cursor;
    for (;;) {
      const answer = await list({ ...params, cursor } as P);
      yield answer;
      const next = answer.page.nextCursor;
      if (!answer.page.hasMore || next === null) return;
      if (next === cursor) throw new VestiarionError(200, "invalid_response", "The API answered the same cursor twice.");
      cursor = next;
    }
  }
  async function* listAll(params?: P): AsyncGenerator<T> {
    for await (const answer of pages(params)) yield* answer.data;
  }
  return { list, pages, listAll };
}

/**
 * A client for one workspace's `/api/v1` (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R4): one method
 * per operation, a resource's `data` returned as it is, and a collection paged by `list`, `pages` or `listAll`.
 */
export class Vestiarion {
  readonly status: { get(): Promise<Status> };
  readonly ledger: Collection<LedgerEntry, ListLedgerEntriesParams> & { verify(): Promise<LedgerVerification> };
  readonly invoices: Collection<Invoice, ListInvoicesParams> & {
    create(input: CreateInvoiceInput, options?: WriteOptions): Promise<Invoice>;
    /** A payable's evidence, as its evidence page's Download evidence gives it, members named by user id. */
    evidence(id: string): Promise<PaymentEvidence>;
    /** A paid payable's receipt: what it states, the entry that recorded it and its checks. Not ready yet: `ready` is false, and `notReady` says why. */
    receipt(id: string): Promise<PaymentReceipt>;
  };
  readonly counterparties: Collection<Counterparty, ListCounterpartiesParams> & {
    get(id: string): Promise<CounterpartyDetail>;
    create(input: CreateCounterpartyInput, options?: WriteOptions): Promise<Counterparty>;
  };
  readonly milestones: Collection<Milestone, ListMilestonesParams> & {
    create(input: CreateMilestoneInput, options?: WriteOptions): Promise<Milestone>;
    /** A milestone's evidence, members named by user id. */
    evidence(id: string): Promise<PaymentEvidence>;
  };
  /**
   * One-time links where a payee enters the address they are paid at. A link's `url` is in the answer only: send it to
   * the payee. Making one revokes the payee's unused link, so a retry gives a working link too.
   */
  readonly payeeLinks: { create(input: CreatePayeeLinkInput): Promise<PayeeLink> };
  readonly treasury: { get(): Promise<Treasury> };
  readonly insights: { get(): Promise<Insights> };
  readonly payeeLock: {
    /** Every payout address change in the period, with its checks and its signed entries. */
    evidence(params?: GetPayeeLockEvidenceParams): Promise<PayeeLockEvidence>;
  };
  readonly closePacks: {
    /** The close pack of a calendar month in UTC, `YYYY-MM`: every payment settled in it, one row each, with its signed entry. */
    get(month: string): Promise<ClosePack>;
  };

  constructor(options: VestiarionOptions) {
    if (typeof options?.apiKey !== "string" || !KEY_FORMAT.test(options.apiKey)) {
      throw new TypeError("apiKey must be a workspace API key, shaped vxk_<prefix>_<secret>.");
    }
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    if (!isSafeBaseUrl(baseUrl)) throw new TypeError("baseUrl must be an https URL, or http to localhost: the key must not travel in the clear.");
    // NaN here would retry a failing request forever, or time out every attempt.
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError("maxRetries must be a whole number, 0 or more.");
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive number of milliseconds.");
    const fetchImpl = options.fetch ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as FetchLike) : undefined);
    if (!fetchImpl) throw new TypeError("This runtime has no fetch: pass one as options.fetch.");
    const transport = createTransport({ apiKey: options.apiKey, baseUrl, fetch: fetchImpl, maxRetries, timeoutMs });
    const one = <T>(path: string, query?: object) => transport.request<{ data: T }>({ method: "GET", path, query }).then((answer) => answer.data);
    const add = <T>(path: string, body: unknown, write?: WriteOptions) =>
      transport.request<{ data: T }>({ method: "POST", path, body, idempotencyKey: write?.idempotencyKey }).then((answer) => answer.data);

    this.status = { get: () => one<Status>("/api/v1/status") };
    this.ledger = {
      ...collection<LedgerEntry, ListLedgerEntriesParams>(transport, "/api/v1/ledger"),
      verify: () => one<LedgerVerification>("/api/v1/ledger/verify"),
    };
    this.invoices = {
      ...collection<Invoice, ListInvoicesParams>(transport, "/api/v1/invoices"),
      create: (input, write) => add<Invoice>("/api/v1/invoices", input, write),
      // The API checks the id: one that is not a payable of the workspace answers 404, which is thrown at once.
      evidence: (id) => one<PaymentEvidence>(`/api/v1/invoices/${encodeURIComponent(id)}/evidence`),
      receipt: (id) => one<PaymentReceipt>(`/api/v1/invoices/${encodeURIComponent(id)}/receipt`),
    };
    this.counterparties = {
      ...collection<Counterparty, ListCounterpartiesParams>(transport, "/api/v1/counterparties"),
      get: (id) => one<CounterpartyDetail>(`/api/v1/counterparties/${encodeURIComponent(id)}`),
      create: (input, write) => add<Counterparty>("/api/v1/counterparties", input, write),
    };
    this.milestones = {
      ...collection<Milestone, ListMilestonesParams>(transport, "/api/v1/milestones"),
      create: (input, write) => add<Milestone>("/api/v1/milestones", input, write),
      evidence: (id) => one<PaymentEvidence>(`/api/v1/milestones/${encodeURIComponent(id)}/evidence`),
    };
    // The API keeps no outcome for a payee link's key, so none is sent (write API part 2, W3).
    this.payeeLinks = {
      create: (input) =>
        transport.request<{ data: PayeeLink }>({ method: "POST", path: "/api/v1/payee-links", body: input, idempotencyKey: null }).then((answer) => answer.data),
    };
    this.treasury = { get: () => one<Treasury>("/api/v1/treasury") };
    this.insights = { get: () => one<Insights>("/api/v1/insights") };
    // The evidence reads share a limit per key; a 429 is waited out as any other is (evidence API EA6, EA12).
    this.payeeLock = { evidence: (params) => one<PayeeLockEvidence>("/api/v1/payee-lock/evidence", params) };
    this.closePacks = { get: (month) => one<ClosePack>(`/api/v1/close-packs/${encodeURIComponent(month)}`) };
  }
}
