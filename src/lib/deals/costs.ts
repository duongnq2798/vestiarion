import { utcDay } from "../copy";
import { dealDigits, formatMinor, parseMinor } from "./money";
import { isDay } from "./schedule";

/**
 * A deal's planned costs (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K1-K3): what a deal is expected
 * to cost, entered by a person, and what each cost counts as now: planned, a bill or milestone it became and that is
 * still to pay, paid out, or removed. Browser-safe and pure: the deal page, the deals list and the server read the same
 * answers.
 */

export const COST_LABEL_MAX = 80;
/** No cost is expected more than a year before its deal starts, or ten years after. */
const YEARS_BEFORE = 1;
const YEARS_AFTER = 10;

/** What a cost became, as read now: a payable of the workspace, or a milestone. */
export type CostLink =
  | {
      kind: "payable";
      id: string;
      counterpartyName: string;
      memo: string | null;
      status: string;
      /** `YYYY-MM-DD`. */
      dueOn: string;
      scheduledFor: string | null;
      settledOn: string | null;
      /** In the deal's currency's minor units; null when the bill is in another currency. */
      amountMinor: number | null;
      /** What was paid, after a discount; null before it is paid or when not known. */
      paidMinor: number | null;
    }
  | {
      kind: "milestone";
      id: string;
      title: string;
      contractorName: string;
      status: string;
      settledOn: string | null;
      amountMinor: number | null;
    };

export interface DealCost {
  id: string;
  label: string;
  /** The vendor or contractor it is for, when one was named. */
  counterparty: { id: string; name: string } | null;
  amountMinor: number;
  /** `YYYY-MM-DD`. */
  expectedOn: string;
  /** No bill or quote backs it yet. */
  noDocument: boolean;
  createdAt: string;
  createdBy: string | null;
  removedAt: string | null;
  link: CostLink | null;
}

const PAID_PAYABLE = new Set(["paid"]);
const DROPPED_PAYABLE = new Set(["rejected"]);

/**
 * What a cost counts as today (K2): `planned` on its expected day (today when that day is past; `again` when the bill or
 * milestone it became will not be paid, so the plan stands); `due` when the bill or milestone it became is still to pay,
 * on its day; `paid` when it was paid; `removed`.
 */
export type CostCount =
  | { as: "planned"; day: string; late: boolean; amountMinor: number; again: "rejected" | "closed" | "other_currency" | null }
  | { as: "due"; day: string; late: boolean; amountMinor: number; scheduled: boolean }
  | { as: "paid"; amountMinor: number; on: string | null }
  | { as: "removed" };

const onOrToday = (day: string, today: string) => ({ day: day < today ? today : day, late: day < today });

export function costCount(cost: DealCost, today: string): CostCount {
  if (cost.removedAt) return { as: "removed" };
  const planned = (again: "rejected" | "closed" | "other_currency" | null): CostCount => ({ as: "planned", ...onOrToday(cost.expectedOn, today), amountMinor: cost.amountMinor, again });
  const link = cost.link;
  if (!link) return planned(null);
  if (link.amountMinor === null) return planned("other_currency");
  if (link.kind === "payable") {
    if (PAID_PAYABLE.has(link.status)) return { as: "paid", amountMinor: link.paidMinor ?? link.amountMinor, on: link.settledOn };
    if (DROPPED_PAYABLE.has(link.status)) return planned("rejected");
    const scheduled = link.status === "scheduled" && link.scheduledFor !== null;
    return { as: "due", ...onOrToday(scheduled ? (link.scheduledFor as string) : link.dueOn, today), amountMinor: link.amountMinor, scheduled };
  }
  if (link.status === "paid") return { as: "paid", amountMinor: link.amountMinor, on: link.settledOn };
  if (link.status === "closed") return planned("closed");
  // A milestone has no day of its own: it leaves when it is verified, planned for the cost's day.
  return { as: "due", ...onOrToday(cost.expectedOn, today), amountMinor: link.amountMinor, scheduled: false };
}

/** The costs still counted: every cost not removed. */
export function liveCosts(costs: readonly DealCost[]): DealCost[] {
  return costs.filter((cost) => !cost.removedAt);
}

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** What a cost is now, in words, with its day: "Bill from Northwind Hosting, held, due Oct 20, 2026". */
export function costBasis(cost: DealCost, count: CostCount, currency: string): string {
  const money = (minor: number) => `${formatMinor(minor, dealDigits(currency))} ${currency}`;
  const link = cost.link;
  switch (count.as) {
    case "removed":
      return "Removed: counted nowhere";
    case "paid":
      return link?.kind === "milestone"
        ? `Milestone ${link.title} for ${link.contractorName}, paid${count.on ? ` ${dayWords(count.on)}` : ""}`
        : `Bill from ${link?.kind === "payable" ? link.counterpartyName : "a vendor"}, paid${count.on ? ` ${dayWords(count.on)}` : ""}`;
    case "due": {
      const late = count.late ? " (past its day: counted today)" : "";
      if (link?.kind === "milestone") return `Milestone ${link.title} for ${link.contractorName}, ${link.status === "verified" ? "verified" : "not verified yet"}, planned ${dayWords(cost.expectedOn)}${late}`;
      const bill = link?.kind === "payable" ? link : null;
      const differs = bill && bill.amountMinor !== null && bill.amountMinor !== cost.amountMinor ? ` (planned at ${money(cost.amountMinor)})` : "";
      return `Bill from ${bill?.counterpartyName ?? "a vendor"}, ${count.scheduled ? `scheduled for ${dayWords(count.day)}` : `due ${dayWords(bill?.dueOn ?? count.day)}`}${differs}${late}`;
    }
    case "planned": {
      const again =
        count.again === "rejected"
          ? "Its bill was rejected, so the plan stands: "
          : count.again === "closed"
            ? "Its milestone was closed unpaid, so the plan stands: "
            : count.again === "other_currency"
              ? `Its bill is not in ${currency}, so the plan stands: `
              : "";
      const document = cost.noDocument ? ", no document yet" : "";
      return `${again}planned for ${dayWords(cost.expectedOn)}${document}${count.late ? " (past its day: counted today)" : ""}`;
    }
  }
}

export type CostFormField = "label" | "counterpartyId" | "amount" | "expectedOn" | "idempotencyKey";

export interface CostFormFields {
  dealId: string;
  label: string;
  counterpartyId: string;
  amount: string;
  expectedOn: string;
  noDocument: boolean;
  idempotencyKey: string;
}

export interface CostDraft {
  dealId: string;
  label: string;
  counterpartyId: string | null;
  amountMinor: number;
  expectedOn: string;
  noDocument: boolean;
  idempotencyKey: string;
}

export type CostFormRead = { ok: true; draft: CostDraft } | { ok: false; field: CostFormField; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const shiftYears = (day: string, years: number) => `${Number(day.slice(0, 4)) + years}${day.slice(4)}`;

/**
 * The Add a cost form, read the same in the browser and on the server: a name, an optional vendor or contractor, an
 * amount the deal's currency writes, a real day from a year before the deal starts to ten years after it, and the key
 * made when the page was drawn.
 */
export function readCostForm(fields: CostFormFields, deal: { currency: string; startsOn: string }): CostFormRead {
  const label = fields.label.trim();
  if (label.length === 0 || label.length > COST_LABEL_MAX) return { ok: false, field: "label", message: `Say what the cost is, in at most ${COST_LABEL_MAX} characters.` };
  const counterpartyId = fields.counterpartyId.trim();
  if (counterpartyId !== "" && counterpartyId !== "none" && !UUID.test(counterpartyId)) return { ok: false, field: "counterpartyId", message: "Choose a vendor or contractor from the list, or none." };
  const amountMinor = parseMinor(fields.amount, deal.currency);
  if (amountMinor === null) return { ok: false, field: "amount", message: `Give the amount in ${deal.currency}, above zero.` };
  const expectedOn = fields.expectedOn.trim();
  if (!isDay(expectedOn) || expectedOn < shiftYears(deal.startsOn, -YEARS_BEFORE) || expectedOn > shiftYears(deal.startsOn, YEARS_AFTER)) {
    return { ok: false, field: "expectedOn", message: "Give the day the money is expected to leave, within a year before the deal starts and ten years after." };
  }
  const key = fields.idempotencyKey.trim();
  if (key.length < 8 || key.length > 100) return { ok: false, field: "idempotencyKey", message: "This form is out of date. Reload the page and try again." };
  return {
    ok: true,
    draft: {
      dealId: fields.dealId,
      label,
      counterpartyId: counterpartyId === "" || counterpartyId === "none" ? null : counterpartyId,
      amountMinor,
      expectedOn,
      noDocument: fields.noDocument,
      idempotencyKey: key,
    },
  };
}
