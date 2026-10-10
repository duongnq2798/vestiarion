import { z } from "zod";
import { ALL_STAGES, CAMPAIGN_ID, CAMPAIGN_STATUSES, REVENUE_KINDS } from "./fields";

/**
 * What the founder dashboard's forms may send, checked on the server before anything is written. Pure, so each rule is
 * tested on its own. A select with nothing chosen sends `none`.
 */

const NONE = "none";

const optionalText = (max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value ?? "").trim())
    .pipe(z.string().max(max, `At most ${max} characters.`))
    .transform((value) => (value === "" ? null : value));

/** A calendar day that exists, YYYY-MM-DD. */
function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

const day = z.string().trim().refine(isDay, "A day as YYYY-MM-DD.");

const optionalDay = z
  .string()
  .optional()
  .transform((value) => (value ?? "").trim())
  .refine((value) => value === "" || isDay(value), "A day as YYYY-MM-DD.")
  .transform((value) => (value === "" ? null : value));

/** A figure of at least 0 with at most `decimals` decimals; blank as null. */
const optionalFigure = (max: number, decimals: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value ?? "").trim().replace(/,/g, ""))
    .refine((value) => value === "" || (new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(value) && Number(value) <= max), `A figure from 0 to ${max}, with at most ${decimals} decimals.`)
    .transform((value) => (value === "" ? null : Number(value)));

const uuid = z.string().trim().uuid("That lead could not be read.");
const optionalUuid = z
  .string()
  .optional()
  .transform((value) => (value ?? NONE).trim())
  .refine((value) => value === NONE || value === "" || z.string().uuid().safeParse(value).success, "That could not be read.")
  .transform((value) => (value === NONE || value === "" ? null : value));

const optionalCampaign = z
  .string()
  .optional()
  .transform((value) => (value ?? NONE).trim())
  .refine((value) => value === NONE || value === "" || CAMPAIGN_ID.test(value), "That campaign could not be read.")
  .transform((value) => (value === NONE || value === "" ? null : value));

/** "1, 4, 12" → [1, 4, 12]: each a GTM strategy number from 1 to 50, once. */
const strategies = z
  .string()
  .optional()
  .transform((value) => (value ?? "").split(/[\s,]+/).filter(Boolean))
  .refine((parts) => parts.every((part) => /^\d{1,2}$/.test(part) && Number(part) >= 1 && Number(part) <= 50), "Strategy numbers from 1 to 50, separated by commas.")
  .transform((parts) => [...new Set(parts.map(Number))].sort((a, b) => a - b));

export const campaignSchema = z
  .object({
    id: z.string().trim().toLowerCase().regex(CAMPAIGN_ID, "An id of 2 to 40 characters: a-z, 0-9 and -."),
    name: z.string().trim().min(1, "Give the campaign a name.").max(120, "At most 120 characters."),
    strategies,
    segment: optionalText(200),
    offer: optionalText(500),
    starts_on: optionalDay,
    ends_on: optionalDay,
    cash_budget_usd: optionalFigure(10_000_000, 2),
    hour_budget: optionalFigure(99_999, 1),
    status: z.enum(CAMPAIGN_STATUSES, { message: "Choose a status." }),
  })
  .refine((campaign) => !campaign.starts_on || !campaign.ends_on || campaign.ends_on >= campaign.starts_on, { message: "The end day is before the start day.", path: ["ends_on"] });
export type CampaignInput = z.infer<typeof campaignSchema>;

export const spendSchema = z
  .object({
    campaign_id: optionalCampaign,
    spent_on: day,
    usd: optionalFigure(10_000_000, 2).transform((value) => value ?? 0),
    founder_hours: optionalFigure(99_999, 1).transform((value) => value ?? 0),
    note: optionalText(500),
  })
  .refine((spend) => spend.usd > 0 || spend.founder_hours > 0, { message: "Enter an amount, hours, or both.", path: ["usd"] });
export type SpendInput = z.infer<typeof spendSchema>;

export const revenueSchema = z
  .object({
    kind: z.enum(REVENUE_KINDS, { message: "Choose what happened." }),
    amount: optionalFigure(100_000_000, 2),
    currency: z
      .string()
      .optional()
      .transform((value) => (value ?? "").trim().toUpperCase())
      .refine((value) => value === "" || /^[A-Z]{3,5}$/.test(value), "A currency code such as USD.")
      .transform((value) => (value === "" ? null : value)),
    occurred_on: day,
    lead_id: optionalUuid,
    workspace: optionalText(80),
    reference: optionalText(200),
    note: optionalText(1000),
  })
  .refine((revenue) => (revenue.amount === null) === (revenue.currency === null), { message: "Give an amount with its currency, or neither.", path: ["amount"] })
  .refine((revenue) => revenue.kind !== "payment_received" || revenue.amount !== null, { message: "A payment received needs its amount and currency.", path: ["amount"] });
export type RevenueInput = z.infer<typeof revenueSchema>;

export const stageSchema = z.object({
  lead_id: uuid,
  stage: z.enum(ALL_STAGES as [string, ...string[]], { message: "Choose a stage." }),
  note: optionalText(1000),
});

export const linkSchema = z.object({
  lead_id: uuid,
  // A workspace's slug or id; blank unlinks.
  workspace: optionalText(80),
  note: optionalText(1000),
});

export const decisionSchema = z
  .object({
    lead_id: uuid,
    decision: z.enum(["approve", "reject"], { message: "Choose approve or reject." }),
    note: optionalText(1000),
  })
  .refine((decision) => decision.decision === "approve" || decision.note !== null, { message: "Say why it is rejected.", path: ["note"] });

/** The first problem with a form, in words to show beside it. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That could not be read.";
}

/** A form's fields as strings; a file or a repeated field is not one of ours. */
export function formFields(formData: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (typeof value === "string" && !(key in fields)) fields[key] = value;
  return fields;
}
