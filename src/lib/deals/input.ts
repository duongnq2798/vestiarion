import { dealCurrency, dealDigits, parseMinor } from "./money";
import type { ProposedLine } from "./revision";
import {
  buildSchedule,
  carryRounding,
  DEAL_TEMPLATES,
  DEFAULT_TERMS_DAYS,
  isDay,
  MAX_LINES,
  type DealTemplate,
  type ScheduleLine,
  type TemplateInput,
} from "./schedule";

/**
 * The New deal and Change deal forms, read (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D2-D6, D12).
 * Browser-safe and pure: the form previews the schedule with it as the person types, and the server reads the posted
 * fields again with it before anything is written. The schedule's lines travel as JSON, in minor units.
 */

export const TITLE_MAX = 120;
export const CUSTOMER_NAME_MAX = 160;
export const EXTERNAL_REF_MAX = 200;
export const REASON_MAX = 280;

/** Every field of the New deal form, as text. */
export interface DealFormFields {
  /** A counterparty's id, or `new` with `customerName`. */
  customerId: string;
  customerName: string;
  title: string;
  currency: string;
  total: string;
  startsOn: string;
  termsDays: string;
  externalRef: string;
  template: string;
  depositPct: string;
  deliveryOn: string;
  /** JSON: `[{ label?, invoiceOn }]`. */
  milestones: string;
  months: string;
  dayOfMonth: string;
  /** JSON: `[{ label, invoiceOn, amountMinor }]`: the lines as the person edited them. */
  lines: string;
  /** `1` when the person edited the template's lines: they are then taken as typed. */
  edited: string;
  autoRelease: boolean;
  idempotencyKey: string;
}

export type DealFormField = keyof DealFormFields;

export interface DealDraft {
  customer: { id: string } | { name: string };
  title: string;
  currency: string;
  digits: 0 | 2;
  totalMinor: number;
  startsOn: string;
  termsDays: number;
  externalRef: string | null;
  template: DealTemplate;
  lines: ScheduleLine[];
  autoRelease: boolean;
  idempotencyKey: string;
}

export type DealFormResult = { ok: true; draft: DealDraft } | { ok: false; field: DealFormField; message: string };

const KEY = /^[A-Za-z0-9-]{8,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "[]");
  } catch {
    return null;
  }
}

const integer = (text: string): number | null => (/^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null);

/** The template's own inputs, as the schedule builder takes them. */
export function templateInputOf(fields: Pick<DealFormFields, "template" | "depositPct" | "deliveryOn" | "milestones" | "months" | "dayOfMonth" | "lines">): TemplateInput | null {
  switch (fields.template) {
    case "deposit":
      return { kind: "deposit", depositPct: fields.depositPct, deliveryOn: fields.deliveryOn.trim() };
    case "milestones": {
      const parsed = parseJson(fields.milestones);
      if (!Array.isArray(parsed)) return null;
      return {
        kind: "milestones",
        milestones: parsed.map((item) => ({
          label: typeof item?.label === "string" ? item.label : undefined,
          invoiceOn: typeof item?.invoiceOn === "string" ? item.invoiceOn : "",
        })),
      };
    }
    case "retainer":
      return { kind: "retainer", months: integer(fields.months) ?? 0, dayOfMonth: integer(fields.dayOfMonth) ?? 0 };
    case "custom": {
      const lines = postedLines(fields.lines);
      return lines ? { kind: "custom", lines } : null;
    }
    default:
      return null;
  }
}

/** The posted lines, or null when they are not lines. */
export function postedLines(text: string): Array<{ label: string; invoiceOn: string; amountMinor: number }> | null {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || parsed.length > MAX_LINES) return null;
  const lines: Array<{ label: string; invoiceOn: string; amountMinor: number }> = [];
  for (const item of parsed) {
    if (!item || typeof item.label !== "string" || typeof item.invoiceOn !== "string" || !Number.isSafeInteger(item.amountMinor)) return null;
    lines.push({ label: item.label, invoiceOn: item.invoiceOn, amountMinor: item.amountMinor });
  }
  return lines;
}

/** The New deal form, checked: the customer, the deal's terms and its schedule, or the first field in the way. */
export function readDealForm(fields: DealFormFields, workspace: { shadowOn: boolean }): DealFormResult {
  const fail = (field: DealFormField, message: string): DealFormResult => ({ ok: false, field, message });

  let customer: DealDraft["customer"];
  if (fields.customerId === "new") {
    const name = fields.customerName.trim();
    if (name.length < 2 || name.length > CUSTOMER_NAME_MAX) return fail("customerName", "Type the new customer's name, in 2 to 160 characters.");
    customer = { name };
  } else if (UUID.test(fields.customerId)) {
    customer = { id: fields.customerId };
  } else {
    return fail("customerId", "Choose the customer, or add a new one.");
  }

  const title = fields.title.trim();
  if (title.length === 0 || title.length > TITLE_MAX) return fail("title", `Name the deal, in at most ${TITLE_MAX} characters.`);
  const currency = dealCurrency(fields.currency, workspace);
  if (!currency) {
    return fail("currency", workspace.shadowOn ? "Choose USDC, EURC or your business's currency." : "Choose USDC or EURC.");
  }
  const digits = dealDigits(currency);
  const totalMinor = parseMinor(fields.total, currency);
  if (totalMinor === null) {
    return fail("total", digits === 0 ? `Type the total in whole ${currency}, above zero.` : "Type the total above zero, with at most two decimals.");
  }
  const startsOn = fields.startsOn.trim();
  if (!isDay(startsOn)) return fail("startsOn", "Give the day the deal starts.");
  const termsText = fields.termsDays.trim();
  const termsDays = termsText === "" ? DEFAULT_TERMS_DAYS : integer(termsText);
  if (termsDays === null || termsDays > 365) return fail("termsDays", "Payment terms are 0 to 365 days.");
  const externalRef = fields.externalRef.trim() || null;
  if (externalRef && externalRef.length > EXTERNAL_REF_MAX) return fail("externalRef", `Keep the reference to ${EXTERNAL_REF_MAX} characters.`);
  if (!(DEAL_TEMPLATES as readonly string[]).includes(fields.template)) return fail("template", "Choose how the deal is billed.");
  const template = fields.template as DealTemplate;
  if (!KEY.test(fields.idempotencyKey)) return fail("idempotencyKey", "Reload the page and confirm the deal again.");

  const deal = { totalMinor, currency, startsOn, termsDays };
  const templateInput = templateInputOf(fields);
  const built = templateInput ? buildSchedule({ ...deal, template: templateInput }) : null;
  let lines: ScheduleLine[];
  if (template === "custom" || fields.edited === "1") {
    const posted = postedLines(fields.lines);
    if (!posted) return fail("lines", "Give every line a name, an invoice day and an amount.");
    const custom = buildSchedule({ ...deal, template: { kind: "custom", lines: posted } });
    if (!custom.ok) return fail(custom.code === "sum" ? "total" : "lines", custom.message);
    // A line keeps its rounding only where it is the one the template built.
    const rounding = carryRounding(posted, built?.ok ? built.lines : []);
    lines = custom.lines.map((line, index) => ({ ...line, roundingMinor: rounding[index] }));
  } else {
    if (!built) return fail("template", "Fill in how the deal is billed.");
    if (!built.ok) return fail(built.code === "delivery_on" ? "deliveryOn" : built.code === "deposit_pct" ? "depositPct" : built.code === "months" ? "months" : built.code === "day_of_month" ? "dayOfMonth" : "template", built.message);
    lines = built.lines;
  }

  return { ok: true, draft: { customer, title, currency, digits, totalMinor, startsOn, termsDays, externalRef, template, lines, autoRelease: fields.autoRelease, idempotencyKey: fields.idempotencyKey } };
}

/** The Change deal form's fields, as text. */
export interface ChangeFormFields {
  dealId: string;
  baseVersion: string;
  kind: string;
  /** The new total as typed; unused by a cancel. */
  total: string;
  reason: string;
  /** JSON: `[{ id?, kind, label, invoiceOn, amountMinor }]`: the planned lines as proposed. */
  lines: string;
  idempotencyKey: string;
}

export interface ChangeDraft {
  dealId: string;
  baseVersion: number;
  kind: "revised" | "reopened" | "cancelled";
  totalMinor: number | null;
  reason: string | null;
  lines: ProposedLine[];
  idempotencyKey: string;
}

/** The Change deal form, checked for its shape; the change itself is planned against the deal as it is now. */
export function readChangeForm(fields: ChangeFormFields, currency: string): { ok: true; change: ChangeDraft } | { ok: false; message: string } {
  if (!UUID.test(fields.dealId)) return { ok: false, message: "That deal was not found." };
  const baseVersion = integer(fields.baseVersion);
  if (baseVersion === null || baseVersion < 1) return { ok: false, message: "Reload the page and make the change again." };
  if (fields.kind !== "revised" && fields.kind !== "reopened" && fields.kind !== "cancelled") return { ok: false, message: "Choose what to change." };
  if (!KEY.test(fields.idempotencyKey)) return { ok: false, message: "Reload the page and make the change again." };
  const reason = fields.reason.trim() || null;
  if (reason && reason.length > REASON_MAX) return { ok: false, message: `Keep the reason to ${REASON_MAX} characters.` };
  if (fields.kind === "cancelled") return { ok: true, change: { dealId: fields.dealId, baseVersion, kind: "cancelled", totalMinor: null, reason, lines: [], idempotencyKey: fields.idempotencyKey } };

  const totalMinor = parseMinor(fields.total, currency);
  if (totalMinor === null) return { ok: false, message: "Type the deal's new total, above zero." };
  const parsed = parseJson(fields.lines);
  if (!Array.isArray(parsed) || parsed.length > MAX_LINES) return { ok: false, message: "Give every line a name, an invoice day and an amount." };
  const lines: ProposedLine[] = [];
  for (const item of parsed) {
    const kind = item?.kind === "credit" ? "credit" : item?.kind === "charge" ? "charge" : null;
    if (!kind || typeof item.label !== "string" || typeof item.invoiceOn !== "string" || !Number.isSafeInteger(item.amountMinor)) {
      return { ok: false, message: "Give every line a name, an invoice day and an amount." };
    }
    if (item.id !== undefined && (typeof item.id !== "string" || !UUID.test(item.id))) return { ok: false, message: "Reload the page and make the change again." };
    lines.push({ ...(item.id ? { id: item.id } : {}), kind, label: item.label, invoiceOn: item.invoiceOn, amountMinor: item.amountMinor });
  }
  return { ok: true, change: { dealId: fields.dealId, baseVersion, kind: fields.kind, totalMinor, reason, lines, idempotencyKey: fields.idempotencyKey } };
}
