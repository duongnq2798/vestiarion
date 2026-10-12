/**
 * What the connector core asks of an accounting provider (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X1): connecting, its tokens, and paged reads of bills, contacts and accounts, each mapped into the core's own shapes.
 * Xero is the first provider (`src/lib/xero/`), QuickBooks Online the next; nothing under `src/lib/connectors/` names
 * either. Pure types and one error class: no I/O.
 */

export const PROVIDERS = ["xero", "quickbooks", "hubspot"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** A provider's name in copy. */
export const PROVIDER_LABELS: Record<ProviderId, string> = { xero: "Xero", quickbooks: "QuickBooks", hubspot: "HubSpot" };

/**
 * What a provider brings in (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H1): an accounting tool its
 * bills, a CRM its companies and deals. The core's words follow it.
 */
export type ProviderKind = "accounting" | "crm";
export const PROVIDER_KINDS: Record<ProviderId, ProviderKind> = { xero: "accounting", quickbooks: "accounting", hubspot: "crm" };

/** The kind of a provider named by its id or its label; accounting for a name neither is. */
export function providerKind(provider: string): ProviderKind {
  const id = PROVIDERS.find((candidate) => candidate === provider || PROVIDER_LABELS[candidate] === provider);
  return id ? PROVIDER_KINDS[id] : "accounting";
}

/**
 * A provider's own words for what the core names alike (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md
 * Q15): Xero has organisations and suppliers, QuickBooks companies and vendors; and how long a connection may sit
 * unused before the provider stops taking it (Xero's refresh token lives 60 days, QuickBooks' 100).
 */
export interface ProviderWords {
  /** "Xero's", "QuickBooks'". */
  possessive: string;
  organisation: string;
  contacts: string;
  /** What is read to choose the account payments will be booked to: Xero's whole chart, QuickBooks' bank accounts. */
  accounts: string;
  idleDays: number;
  /** The bills that come in: Xero's approved ones, QuickBooks' open ones. */
  bills: string;
  /** What a bill being in the tool does not mean, under the review list. */
  approval: string;
}

export const PROVIDER_WORDS: Record<ProviderId, ProviderWords> = {
  xero: {
    possessive: "Xero's",
    organisation: "organisation",
    contacts: "suppliers",
    accounts: "chart of accounts",
    idleDays: 60,
    bills: "approved bills",
    approval: "Xero approving a bill does not approve its payment: the agent decides it.",
  },
  quickbooks: {
    possessive: "QuickBooks'",
    organisation: "company",
    contacts: "vendors",
    accounts: "bank accounts",
    idleDays: 100,
    bills: "open bills",
    approval: "A bill being open in QuickBooks does not approve its payment: the agent decides it.",
  },
  // A CRM (HubSpot connector H1): an account, its companies, its won deals; no chart, and a refresh token that lasts
  // until the app is uninstalled, so no idle days. The core's words for a CRM are its own (status.ts).
  hubspot: {
    possessive: "HubSpot's",
    organisation: "account",
    contacts: "companies",
    accounts: "no accounts",
    idleDays: 0,
    bills: "won deals",
    approval: "A deal won in HubSpot becomes a deal in Vestiarion only when you plan it.",
  },
};

/** The words of a provider named by its id or its label; Xero's for a name neither is. */
export function providerWords(provider: string): ProviderWords {
  const id = PROVIDERS.find((candidate) => candidate === provider || PROVIDER_LABELS[candidate] === provider);
  return PROVIDER_WORDS[id ?? "xero"];
}

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
  /**
   * False for a bill the provider says only was deleted: QuickBooks' change feed keeps its id and time, and none of its
   * facts (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q8). Its row then keeps the facts it has,
   * and only its status and version change. Absent means true.
   */
  factsKnown?: boolean;
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
  /**
   * The connection's first day (`YYYY-MM-DD`, X9): a provider that can bound its backfill there does (QuickBooks, Q7);
   * the core applies the window to every bill either way.
   */
  windowFrom?: string;
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
  /** The scopes asked for: read-only where the provider has such scopes (Xero), in this version. */
  scopes: readonly string[];
  /**
   * The query parameter the provider's callback names the one organisation of the grant in (QuickBooks' `realmId`,
   * docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4). The callback then fails without it, and passes
   * it to `organisations`, which confirms the new token reads it.
   */
  callbackOrganisationParam?: string;
  /**
   * One workspace per organisation at a time (QuickBooks, Q5): revoking or disconnecting the app there ends every grant
   * for the organisation, so two workspaces would cut each other off. Xero lets several share one (X4).
   */
  exclusive?: boolean;
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<ExchangeOutcome>;
  /**
   * The organisations a fresh token reaches, those of this authorization first where the provider says which; with
   * `named`, the one the callback named, once the token is shown to read it.
   */
  organisations(tokens: ProviderTokens, authEventId: string | null, named?: string): Promise<ExternalOrganisation[]>;
  refresh(refreshToken: string): Promise<RefreshOutcome>;
  /** Ends the access the refresh token grants. True when the provider confirmed it. */
  revoke(refreshToken: string): Promise<boolean>;
  bills(request: PageRequest): Promise<Page<ExternalBill>>;
  contacts(request: PageRequest): Promise<Page<ExternalContact>>;
  /** The chart's accounts a payment can be booked to, read when a person opens the picker. */
  accounts(input: { accessToken: string; externalOrgId: string }): Promise<ExternalAccount[]>;
}

/**
 * What connecting, refreshing a token and disconnecting use of any provider, an accounting tool or a CRM
 * (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H1). `exclusive`: one workspace per organisation at a
 * time (a HubSpot account, H4), checked before connecting.
 */
export type ConnectingProvider = Pick<
  AccountingProvider,
  "id" | "label" | "scopes" | "authorizeUrl" | "exchangeCode" | "organisations" | "refresh" | "revoke" | "exclusive" | "callbackOrganisationParam"
>;

/** The accounting tools among the providers: those that bring bills in (HubSpot connector H1). */
export type AccountingProviderId = Exclude<ProviderId, "hubspot">;
