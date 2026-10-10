import { ALL_STAGES, CAMPAIGN_ID, DEFAULT_SINCE, REVIEW_STATUSES, type ReviewStatus, type Stage } from "./fields";

/**
 * What the founder dashboard's address asks for: `?since=YYYY-MM-DD` (from 2026-01-01 through today, UTC; the default
 * otherwise), whose workspaces to list (`side=ours`, customers' by default), and the leads table's filters. Anything it
 * cannot read is left at its default. Pure.
 */

export interface GrowthView {
  /** The day the window starts, YYYY-MM-DD, UTC. */
  since: string;
  sinceAt: Date;
  /** True when the address named a day that could not be read, so the default is shown instead. */
  sinceFallback: boolean;
  side: "customers" | "ours";
  campaign: string | null;
  stage: Stage | null;
  review: ReviewStatus | null;
}

type Params = Record<string, string | string[] | undefined>;

const EARLIEST = "2026-01-01";
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

function calendarDay(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : value;
}

export function parseGrowthView(params: Params, now: Date = new Date()): GrowthView {
  const asked = one(params.since);
  const day = calendarDay(asked);
  const today = now.toISOString().slice(0, 10);
  const since = day && day >= EARLIEST && day <= today ? day : DEFAULT_SINCE;
  const campaign = one(params.campaign);
  const stage = one(params.stage);
  const review = one(params.review);
  return {
    since,
    sinceAt: new Date(`${since}T00:00:00Z`),
    sinceFallback: asked !== undefined && since !== asked,
    side: one(params.side) === "ours" ? "ours" : "customers",
    campaign: campaign && (campaign === "none" || CAMPAIGN_ID.test(campaign)) ? campaign : null,
    stage: stage && (ALL_STAGES as readonly string[]).includes(stage) ? (stage as Stage) : null,
    review: review && (REVIEW_STATUSES as readonly string[]).includes(review) ? (review as ReviewStatus) : null,
  };
}

/** The dashboard's address for this view with `changes` applied; defaults are left out. */
export function growthHref(view: GrowthView, changes: Partial<Pick<GrowthView, "side" | "campaign" | "stage" | "review">> = {}, hash = ""): string {
  const next = { ...view, ...changes };
  const query = new URLSearchParams();
  if (next.since !== DEFAULT_SINCE) query.set("since", next.since);
  if (next.side === "ours") query.set("side", "ours");
  if (next.campaign) query.set("campaign", next.campaign);
  if (next.stage) query.set("stage", next.stage);
  if (next.review) query.set("review", next.review);
  const search = query.toString();
  return `/admin/growth${search ? `?${search}` : ""}${hash}`;
}
