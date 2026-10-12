import type { ConnectingProvider, Page, PageRequest } from "./provider";

/**
 * What the connector core asks of a CRM (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H1, H6, H10,
 * H12): its deals a page at a time, each with its company and that company's main contact's email, and the deals named
 * by id; and, pure, what to do with a deal read and what changed in it since a person planned it. HubSpot is the first
 * CRM (`src/lib/hubspot/`); nothing here names it. No I/O.
 */

/** What a deal's stage means: still open, closed won, or closed lost. */
export type StageState = "open" | "won" | "lost";

export interface ExternalCompany {
  externalId: string;
  name: string;
  /** The company's main contact's email, where it has one. */
  email: string | null;
}

/** A deal as the core keeps it, whatever the CRM. */
export interface ExternalDeal {
  externalId: string;
  /** The CRM's version of it: its last change, as an ISO string. */
  version: string;
  updatedAt: string;
  name: string;
  /** An exact decimal, or null when the CRM has no amount. */
  amount: string | null;
  /** ISO 4217, or null when neither the deal nor the account says. */
  currency: string | null;
  /** `YYYY-MM-DD`, in the account's own time zone. */
  closeOn: string | null;
  pipelineId: string | null;
  pipelineLabel: string | null;
  stageId: string | null;
  stageLabel: string | null;
  stage: StageState;
  company: ExternalCompany | null;
}

/** A page of deals: a backfill of what is open (and won since `windowFrom`), or the changes since `since`. */
export interface CrmPageRequest extends PageRequest {
  /** The connection's first day (`YYYY-MM-DD`): won deals closed before it are not brought in by a backfill. */
  windowFrom: string;
}

export interface CrmPage extends Page<ExternalDeal> {
  /** The CRM reads no further for this query (HubSpot's search stops at 10,000 results): the run ends here. */
  capped?: boolean;
}

export type CrmProvider = ConnectingProvider & {
  kind: "crm";
  deals(request: CrmPageRequest): Promise<CrmPage>;
  /** The deals named, as the CRM has them now; `missing`, those it no longer has (deleted there). At most 100 ids. */
  dealsById(input: { accessToken: string; externalOrgId: string; ids: readonly string[] }): Promise<{ deals: ExternalDeal[]; missing: string[] }>;
};
