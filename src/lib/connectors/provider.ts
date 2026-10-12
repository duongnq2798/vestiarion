/**
 * What the connector core asks of an accounting provider (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X1): connecting, its tokens, and paged reads of bills, contacts and accounts, each mapped into the core's own shapes.
 * Xero is the first provider (`src/lib/xero/`), QuickBooks Online the next; nothing under `src/lib/connectors/` names
 * either. Pure types and one error class: no I/O.
 */

export const PROVIDERS = ["xero", "quickbooks"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** A provider's name in copy. */
export const PROVIDER_LABELS: Record<ProviderId, string> = { xero: "Xero", quickbooks: "QuickBooks" };

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working, in epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

/** An organisation (a Xero tenant, a QuickBooks company) a token reaches. */
export interface ExternalOrganisation {
  externalOrgId: string;
  name: string;
  /** The provider's own id for this app's connection to it, where it has one (Xero's `/connections` id). */
  connectionId: string | null;
}

/** What the provider says of a bill now, in the core's words (X6). */
export type SourceStatus = "open" | "paid" | "voided" | "deleted" | "draft";

/** A bill as the core keeps it, whatever the provider. */
export interface ExternalBill {
  externalId: string;
  /** The provider's version of it: its last update time, as an ISO string. */
  version: string;
  updatedAt: string;
  contactExternalId: string | null;
  contactName: string;
  /** The bill's own number: the supplier's reference. */
  number: string | null;
  reference: string | null;
  /** ISO 4217, three capital letters. */
  currency: string;
  /** Exact decimals, as strings: the bill's total and what is left to pay. */
  total: string;
  amountDue: string;
  /** `YYYY-MM-DD` */
  issuedOn: string | null;
  dueOn: string | null;
  status: SourceStatus;
}

export interface ExternalContact {
  externalId: string;
  version: string;
  updatedAt: string;
  name: string;
  isSupplier: boolean;
  archived: boolean;
}

/** An account of the chart a payment can be booked to (I14). */
export interface ExternalAccount {
  externalId: string;
  code: string | null;
  name: string;
  /** The provider's own type, such as Xero's `BANK`. */
  type: string;
  /** ISO 4217, or null when the account takes the organisation's own currency. */
  currency: string | null;
  bank: boolean;
}

/** One page of a paged read. `last` when no page follows it. */
export interface Page<T> {
  items: T[];
  page: number;
  last: boolean;
  /**
   * How many records the read matches now, where the provider says (Xero's `pagination.itemCount`): fewer than on the
   * page before means one left the read, and the next moved up into a page already read (X8).
   */
  total?: number | null;
}

/**
 * A read either starts over (`backfill`: what is open now) or follows changes (`incremental`: everything changed since
 * `since`, whatever its status).
 */
export interface PageRequest {
  accessToken: string;
  externalOrgId: string;
  page: number;
  phase: "backfill" | "incremental";
  /** ISO time: only records changed since then. Null in a backfill. */
  since: string | null;
}

export type ProviderFailure = "rate_limited" | "unauthorized" | "forbidden" | "unavailable" | "bad_response";

/**
 * A call to a provider that did not answer as hoped. `rate_limited` carries the wait the provider asked for;
 * `unauthorized` is an access token it no longer takes; `forbidden` an organisation that took the app's access away;
 * `unavailable` a 5xx, a timeout or a network failure; `bad_response` an answer that does not read. The message names
 * the call and a status, never a token or a body.
 */
export class ProviderError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ExchangeOutcome =
  | { ok: true; tokens: ProviderTokens; authEventId: string | null }
  | { ok: false; reason: "refused" | "unavailable" };

export type RefreshOutcome =
  | { ok: true; tokens: ProviderTokens }
  | { ok: false; reason: "reconnect" }
  | { ok: false; reason: "unavailable"; retryAfterMs: number | null };

export interface AccountingProvider {
  id: ProviderId;
  label: string;
  /** The scopes asked for: the read scopes, and the write scopes `booking` needs (Xero: `accounting.payments`). */
  scopes: readonly string[];
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<ExchangeOutcome>;
  /** The organisations a fresh token reaches, those of this authorization first where the provider says which. */
  organisations(tokens: ProviderTokens, authEventId: string | null): Promise<ExternalOrganisation[]>;
  refresh(refreshToken: string): Promise<RefreshOutcome>;
  /** Ends the access the refresh token grants. True when the provider confirmed it. */
  revoke(refreshToken: string): Promise<boolean>;
  bills(request: PageRequest): Promise<Page<ExternalBill>>;
  contacts(request: PageRequest): Promise<Page<ExternalContact>>;
  /** The chart's accounts a payment can be booked to, read when a person opens the picker. */
  accounts(input: { accessToken: string; externalOrgId: string }): Promise<ExternalAccount[]>;
  /**
   * Booking payments made on Arc against the provider's bills (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
   * W11). Optional: a provider without it never books, and its connections show nothing about booking.
   */
  booking?: BookingProvider;
}

/** Which organisation a booking call names, with a fresh access token. */
export interface OrgRequest {
  accessToken: string;
  externalOrgId: string;
}

/**
 * What the provider says of the organisation (W1): `demo` only when it says so itself (Xero's Demo Company, a
 * QuickBooks sandbox company). Anything else, a trial included, is a real business's books.
 */
export interface OrganisationFacts {
  externalOrgId: string;
  name: string;
  demo: boolean;
  /** ISO 4217, or null when the provider does not say. */
  baseCurrency: string | null;
}

/** A payment booked against a bill in the provider, as the core reads it back. */
export interface ExternalPayment {
  externalId: string;
  billExternalId: string | null;
  accountExternalId: string | null;
  /** Exact decimals, in the bill's currency. */
  amount: string;
  currency: string | null;
  /** `YYYY-MM-DD` */
  date: string | null;
  reference: string | null;
  /** `deleted`: someone reversed it in the provider; it is never booked again on its own. */
  status: "active" | "deleted";
}

/** One payment to book: against this bill, from this account, on this day, for this amount, with this reference. */
export interface PaymentToBook {
  billExternalId: string;
  accountExternalId: string;
  /** Exact decimals, in `currency`, the bill's. */
  amount: string;
  currency: string;
  /** `YYYY-MM-DD` */
  date: string;
  reference: string;
}

/** The provider's answer to a booking: the payment it made, or its refusal in its own words (a 400's validation errors). */
export type BookOutcome = { ok: true; payment: ExternalPayment } | { ok: false; message: string };

/**
 * The seam a provider implements to book payments (W11). Each call maps the provider's JSON into the core's shapes; a
 * timeout, a 5xx, a rate limit or a refused token throws `ProviderError`, as every other call does.
 */
export interface BookingProvider {
  /** The scopes booking needs beyond reading (Xero: `accounting.payments`): a connection without them reconnects first. */
  writeScopes: readonly string[];
  organisation(input: OrgRequest): Promise<OrganisationFacts>;
  /** One bill as it is now; null when the provider no longer has it. */
  bill(input: OrgRequest & { billId: string }): Promise<ExternalBill | null>;
  /** A payment on this bill carrying this reference, deleted ones included; null when there is none. */
  findPayment(input: OrgRequest & { billId: string; reference: string }): Promise<ExternalPayment | null>;
  /** Books one payment. The key makes the same booking the same request to the provider. */
  bookPayment(input: OrgRequest & { payment: PaymentToBook; idempotencyKey: string }): Promise<BookOutcome>;
  /** Reads one payment back by its id; null when the provider has none. */
  payment(input: OrgRequest & { paymentId: string }): Promise<ExternalPayment | null>;
}
