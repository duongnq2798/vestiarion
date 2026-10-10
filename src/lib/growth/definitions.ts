/**
 * What each figure on the founder dashboard means, shown in its Definitions section: where it comes from, how it is
 * worked out, over what window, how a duplicate is kept out, and what it cannot know. Kept beside the code it
 * describes (src/lib/growth/metrics.ts, migration 0099) so a change to one is a change to the other.
 */

export interface Definition {
  metric: string;
  source: string;
  calculation: string;
  window: string;
  dedupe: string;
  limits: string;
}

const LEADS_WINDOW = "Leads added on or after the chosen day (UTC); their stage events count whenever they happened.";
const LEAD_DEDUPE = "One lead per dedupe key: the company address's host without www., else the trimmed lower-case business name.";
const REACHED = "Reached a stage: the lead's current stage, or any stage it was moved from or to (growth_lead_events), at or beyond it in the ordered list. Disqualified and lost leads keep the furthest stage they reached.";
const WORKSPACES_WINDOW = "Workspaces opened on or after the chosen day (UTC).";
const CUSTOMERS = "Customers' workspaces only: opened by someone off platform_team, the same rule as open_funnel (0089).";

export const DEFINITIONS: readonly Definition[] = [
  {
    metric: "Product funnel",
    source: "open_funnel (migration 0089), one call per network.",
    calculation: "Workspaces opened, then how many reached each step: a real bill, the agent's decision on one, a confirmed live payment, payments on two UTC days, a verdict, two people.",
    window: WORKSPACES_WINDOW,
    dedupe: "Each workspace counted once per step.",
    limits: "Each network is its own table, never added to the other. Sample data never counts.",
  },
  {
    metric: "Leads sourced, qualified, contacts sent",
    source: "growth_leads and growth_lead_events.",
    calculation: `Leads added; leads that reached qualified; leads that reached contacted. ${REACHED}`,
    window: LEADS_WINDOW,
    dedupe: LEAD_DEDUPE,
    limits: "Only what the team records. A contact made outside the dashboard counts once someone moves the lead to contacted.",
  },
  {
    metric: "Response rate, qualified conversation rate, workspace signup conversion",
    source: "growth_leads and growth_lead_events.",
    calculation: "Leads that reached replied, conversation or workspace_created, each over leads that reached contacted.",
    window: LEADS_WINDOW,
    dedupe: LEAD_DEDUPE,
    limits: "Not enough data yet while no lead has reached contacted. A signup counts when the team moves the lead, not when the workspace opens.",
  },
  {
    metric: "Real-invoice activation rate",
    source: "growth_workspaces (migration 0099).",
    calculation: "Customer workspaces with the agent's decision on a real bill, over customer workspaces opened; shown per network as well.",
    window: WORKSPACES_WINDOW,
    dedupe: `${CUSTOMERS} Each workspace once.`,
    limits: "Activation is the agent's decision on a real bill (a payable whose counterparty is not sample data). Whether a person looked at it is only known when they gave a verdict or acted.",
  },
  {
    metric: "Median minutes to first decision",
    source: "growth_workspaces.",
    calculation: "For each customer workspace with a decision on a real bill, the minutes from opening to the first one; the median of those.",
    window: WORKSPACES_WINDOW,
    dedupe: CUSTOMERS,
    limits: "Workspaces with no decision yet are left out, not counted as slow.",
  },
  {
    metric: "7-day repeat rate",
    source: "growth_workspaces.",
    calculation: "Customer workspaces with a second real bill added within 7 days of the first, over customer workspaces whose first real bill is at least 7 days old.",
    window: WORKSPACES_WINDOW,
    dedupe: CUSTOMERS,
    limits: "A workspace whose first real bill is under 7 days old is in neither side yet. Bills are counted by when they were added, not their due dates.",
  },
  {
    metric: "Paid pilot conversion",
    source: "growth_leads and growth_lead_events.",
    calculation: "Leads that reached paid_pilot, over leads that reached conversation.",
    window: LEADS_WINDOW,
    dedupe: LEAD_DEDUPE,
    limits: "Not enough data yet while no lead has reached conversation.",
  },
  {
    metric: "Verified software revenue",
    source: "growth_revenue.",
    calculation: "The sum of payment_received events, per currency.",
    window: "Events dated on or after the chosen day (UTC).",
    dedupe: "Each event once; the team records each payment once, with its reference.",
    limits: "Never converted between currencies and never mixed with payment volume, which is customers' USDC moving through Vestiarion, not revenue. Pricing talks, pilots agreed and invoices issued are recorded but never counted.",
  },
  {
    metric: "Cash spend and founder hours",
    source: "growth_spend.",
    calculation: "The sums of the amounts in USD and of the hours logged.",
    window: "Spend dated on or after the chosen day (UTC).",
    dedupe: "Each entry once.",
    limits: "Only what the team logs.",
  },
  {
    metric: "Cost per activated customer",
    source: "growth_spend, growth_leads and growth_lead_events.",
    calculation: "Cash spend over leads that reached real_invoice_reviewed.",
    window: "Spend and leads as above.",
    dedupe: LEAD_DEDUPE,
    limits: "Not enough data yet while no lead has reached real_invoice_reviewed. Founder hours are not priced in.",
  },
  {
    metric: "Workspace source",
    source: "org_attribution (the first-touch cookie), else the lead linked to the workspace.",
    calculation: "utm_source, utm_campaign and ref of the visit that first carried a campaign tag in that browser; else the linked lead's source.",
    window: "The cookie lasts 90 days from that visit.",
    dedupe: "First touch only: recorded once per workspace, never replaced.",
    limits: "Unknown when the person arrived without a tag, refused cookies, or used another browser.",
  },
];
