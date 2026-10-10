/**
 * The growth tables' fixed values (migration 0099), in one place for the dashboard, its forms, the CSV import and the
 * checks the database holds. Pure: the browser's forms read these too.
 */

/** A lead's stages, in order: reaching one means having been at it or further. */
export const STAGES = [
  "discovered",
  "verified",
  "qualified",
  "contact_approved",
  "contacted",
  "replied",
  "conversation",
  "trial_started",
  "workspace_created",
  "real_invoice_reviewed",
  "second_invoice",
  "live_payment",
  "pricing_conversation",
  "paid_pilot",
  "paying_customer",
] as const;
export type OrderedStage = (typeof STAGES)[number];

/** Where a lead can end without an order: it keeps the furthest stage it reached before. */
export const SIDE_STATES = ["disqualified", "lost"] as const;
export type Stage = OrderedStage | (typeof SIDE_STATES)[number];
export const ALL_STAGES: readonly Stage[] = [...STAGES, ...SIDE_STATES];

export const STAGE_WORDS: Record<Stage, string> = {
  discovered: "Discovered",
  verified: "Verified",
  qualified: "Qualified",
  contact_approved: "Contact approved",
  contacted: "Contacted",
  replied: "Replied",
  conversation: "Conversation",
  trial_started: "Trial started",
  workspace_created: "Workspace created",
  real_invoice_reviewed: "Real invoice reviewed",
  second_invoice: "Second invoice",
  live_payment: "Live payment",
  pricing_conversation: "Pricing conversation",
  paid_pilot: "Paid pilot",
  paying_customer: "Paying customer",
  disqualified: "Disqualified",
  lost: "Lost",
};

export const REVIEW_STATUSES = ["needs_review", "approved_to_contact", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_WORDS: Record<ReviewStatus, string> = {
  needs_review: "Needs review",
  approved_to_contact: "Approved to contact",
  rejected: "Rejected",
};

export const SOURCES = ["warm_intro", "signal_outbound", "community", "inbound", "referral", "content", "directory", "other"] as const;
export type LeadSource = (typeof SOURCES)[number];

export const SEGMENTS = ["software_agency", "creative_agency", "cloud_devops", "web3_studio", "stablecoin_ops", "other"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const CONTACT_CHANNELS = ["email", "linkedin", "x", "telegram", "discord", "warm_intro", "website_form", "other"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

export const CAMPAIGN_STATUSES = ["planned", "running", "continue", "iterate", "pause", "scale", "stopped"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const REVENUE_KINDS = ["pricing_discussed", "willingness_stated", "pilot_agreed", "invoice_issued", "payment_received"] as const;
export type RevenueKind = (typeof REVENUE_KINDS)[number];
export const REVENUE_WORDS: Record<RevenueKind, string> = {
  pricing_discussed: "Pricing discussed",
  willingness_stated: "Willingness stated",
  pilot_agreed: "Pilot agreed",
  invoice_issued: "Invoice issued",
  payment_received: "Payment received",
};

/** A campaign's id: what growth_campaigns_id_check allows. */
export const CAMPAIGN_ID = /^[a-z0-9-]{2,40}$/;

/** The first day the dashboard reads from when the address names none. */
export const DEFAULT_SINCE = "2026-09-27";

/** A value's words: `signal_outbound` → "signal outbound". */
export function words(value: string): string {
  return value.replaceAll("_", " ");
}
