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

/** What is kept of a deal already read. */
export interface StagedCrmDeal {
  id: string;
  externalVersion: string | null;
  sourceStatus: "present" | "deleted";
  /** The Vestiarion deal a person made of it. */
  dealId: string | null;
}

export type CrmDealPlan = { kind: "ignore"; reason: "older" | "outside" | "lost" } | { kind: "insert" } | { kind: "update" };

/**
 * What to do with a deal read (H9, H10): a new open deal is kept, and a won one closed in the window (or with no close
 * day); a lost deal never kept is not; a row kept follows its deal whatever happens to it, by its version.
 */
export function planCrmDeal(row: StagedCrmDeal | null, deal: ExternalDeal, windowFrom: string): CrmDealPlan {
  if (row === null) {
    if (deal.stage === "lost") return { kind: "ignore", reason: "lost" };
    if (deal.stage === "won" && deal.closeOn !== null && deal.closeOn < windowFrom) return { kind: "ignore", reason: "outside" };
    return { kind: "insert" };
  }
  // Versions are ISO instants in one format, so they compare as text: an equal or older one is already known.
  if (row.externalVersion !== null && deal.version <= row.externalVersion) return { kind: "ignore", reason: "older" };
  return { kind: "update" };
}

/** Why a deal can or cannot become a Vestiarion deal now (H11). */
export function plannable(facts: {
  stage: StageState;
  sourceStatus: "present" | "deleted";
  dealId: string | null;
  amount: string | null;
  companyExternalId: string | null;
}, label: string): { ok: true } | { ok: false; reason: string } {
  if (facts.dealId) return { ok: false, reason: "Planned already" };
  if (facts.sourceStatus === "deleted") return { ok: false, reason: `Deleted in ${label}` };
  if (facts.stage !== "won") return { ok: false, reason: "Not won yet" };
  if (facts.amount === null || Number(facts.amount) <= 0) return { ok: false, reason: `No amount in ${label}` };
  if (!facts.companyExternalId) return { ok: false, reason: `No company in ${label}` };
  return { ok: true };
}

/** The facts of a deal a change is told by (H12): kept as the baseline when a deal is planned, and compared later. */
export interface CrmFacts {
  amount: string | null;
  currency: string | null;
  closeOn: string | null;
  stage: StageState;
  stageLabel: string | null;
}

export function factsOf(deal: Pick<ExternalDeal, "amount" | "currency" | "closeOn" | "stage" | "stageLabel">): CrmFacts {
  return { amount: deal.amount, currency: deal.currency, closeOn: deal.closeOn, stage: deal.stage, stageLabel: deal.stageLabel };
}

/** A baseline as stored (`crm_deals.baseline`), or null when it does not read. */
export function readFacts(value: unknown): CrmFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const { amount, currency, closeOn, stage, stageLabel } = value as Record<string, unknown>;
  if (stage !== "open" && stage !== "won" && stage !== "lost") return null;
  const textOrNull = (field: unknown) => (typeof field === "string" ? field : null);
  return { amount: textOrNull(amount), currency: textOrNull(currency), closeOn: textOrNull(closeOn), stage, stageLabel: textOrNull(stageLabel) };
}

export type CrmChange =
  | { what: "amount"; from: { amount: string | null; currency: string | null }; to: { amount: string | null; currency: string | null } }
  | { what: "close"; from: string | null; to: string | null }
  | { what: "stage"; from: StageState; to: StageState; label: string | null }
  | { what: "deleted" };

const sameAmount = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Number(a) === Number(b));

/**
 * What changed in the CRM since the deal was planned or its changes last reviewed (H12): the amount or its currency,
 * the close day, the stage leaving won, or the deal deleted (then that alone: the other facts are the last read). A
 * cancelled deal, or one with no baseline, shows none.
 */
export function crmChanges(baseline: CrmFacts | null, now: CrmFacts & { deleted: boolean }, dealStatus: "active" | "cancelled"): CrmChange[] {
  if (!baseline || dealStatus === "cancelled") return [];
  if (now.deleted) return [{ what: "deleted" }];
  const changes: CrmChange[] = [];
  if (!sameAmount(baseline.amount, now.amount) || baseline.currency !== now.currency) {
    changes.push({ what: "amount", from: { amount: baseline.amount, currency: baseline.currency }, to: { amount: now.amount, currency: now.currency } });
  }
  if (baseline.closeOn !== now.closeOn) changes.push({ what: "close", from: baseline.closeOn, to: now.closeOn });
  if (now.stage !== baseline.stage && now.stage !== "won") changes.push({ what: "stage", from: baseline.stage, to: now.stage, label: now.stageLabel });
  return changes;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-01` as "Oct 1, 2026". */
export function dayWords(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

/** An exact decimal with its thousands grouped: `15000.5` as "15,000.5". */
export function groupedDecimal(amount: string): string {
  const [whole, fraction] = amount.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

/** An amount in its currency for a person, or null for a currency Vestiarion never names (VND). */
export function moneyWords(amount: string | null, currency: string | null): string | null {
  if (currency === "VND") return null;
  if (amount === null) return "no amount";
  return `${groupedDecimal(amount)}${currency ? ` ${currency}` : ""}`;
}

const NOTHING_CANCELLED = "Nothing is cancelled: cancel the deal if it is off.";

/** One change in words, for the deal's page and the list. */
export function crmChangeWords(change: CrmChange, label: string): string {
  switch (change.what) {
    case "amount": {
      const from = moneyWords(change.from.amount, change.from.currency);
      const to = moneyWords(change.to.amount, change.to.currency);
      return from && to ? `Amount: ${from} to ${to}.` : `The amount changed in ${label}.`;
    }
    case "close":
      return `Close date: ${change.from ? dayWords(change.from) : "none"} to ${change.to ? dayWords(change.to) : "none"}.`;
    case "stage":
      return change.to === "lost"
        ? `Marked lost in ${label}${change.label ? ` (${change.label})` : ""}. ${NOTHING_CANCELLED}`
        : `Moved back to an open stage in ${label}${change.label ? ` (${change.label})` : ""}.`;
    case "deleted":
      return `Deleted in ${label}. ${NOTHING_CANCELLED}`;
  }
}

/**
 * Whether a linked deal's changes are recorded now (H12): a new set of changes is, once; the same set again is not; a
 * deal whose changes went (reviewed, or undone in the CRM) has its record cleared, with no entry.
 */
export function flagDecision(changes: readonly CrmChange[], flagged: unknown): "record" | "clear" | "none" {
  const before = Array.isArray(flagged) && flagged.length > 0 ? JSON.stringify(flagged) : null;
  if (changes.length === 0) return before ? "clear" : "none";
  return JSON.stringify(changes) === before ? "none" : "record";
}
