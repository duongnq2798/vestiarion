import { counterpartyFor } from "../bill-import/rows";
import { dealCurrency, dealDigits, formatMinor, MAX_TOTAL_MINOR, minorToDecimal } from "../deals/money";
import { REASON_MAX } from "../deals/input";
import { dayWords, moneyWords, type CrmChange } from "./crm";

/**
 * A CRM's won deal as the New deal form, prefilled, and a change from the CRM as the Change deal form, prefilled
 * (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11, H12). Pure: the page passes what it read, and the
 * person confirms everything through the form every deal uses; the server checks it all again.
 */

/** What of a deal the form is filled from. */
export interface PrefillDeal {
  externalId: string;
  /** The reference the deal carries, where it is not the CRM's id itself (`pipedrive-<id>`, Pipedrive connector P1). */
  reference?: string;
  name: string;
  amount: string | null;
  currency: string | null;
  closeOn: string | null;
  company: { externalId: string; name: string } | null;
}

export interface DealPrefill {
  /** A customer's id, `new` with `customerName`, or empty for the person to choose. */
  customerId: string;
  customerName: string;
  title: string;
  /** Empty when the person types it. */
  total: string;
  currency: string;
  startsOn: string;
  externalRef: string;
  /** What the person should know about the prefill, in plain words. */
  notes: string[];
}

/** Dollars are planned in USDC and euros in EURC, one for one; USDC and EURC as they are. */
const AT_PAR: Record<string, { currency: string; atPar: boolean }> = {
  USD: { currency: "USDC", atPar: true },
  EUR: { currency: "EURC", atPar: true },
  USDC: { currency: "USDC", atPar: false },
  EURC: { currency: "EURC", atPar: false },
};

/**
 * The currency a deal in the CRM's currency is planned in, under today's rules (deal schedule D3): USDC or EURC, or,
 * in shadow mode only, the deal's own currency. Never VND. Null when it cannot be planned in its own currency.
 */
export function plannedCurrency(currency: string | null, workspace: { shadowOn: boolean }): { currency: string; atPar: boolean } | null {
  if (!currency) return null;
  const known = AT_PAR[currency];
  if (known) return known;
  const own = dealCurrency(currency, workspace);
  return own ? { currency: own, atPar: false } : null;
}

/** An exact decimal in the currency's own decimals (`12500` as `12500.00` in USDC), or null when it cannot hold it exactly. */
export function totalFor(amount: string | null, currency: string): string | null {
  if (amount === null) return null;
  const [whole, fraction = ""] = amount.split(".");
  const digits = dealDigits(currency);
  if (fraction.length > digits) return null;
  const minor = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_TOTAL_MINOR) return null;
  return minorToDecimal(minor, digits);
}

export function dealPrefill(input: {
  deal: PrefillDeal;
  /** The customer the deal's company is linked to by its id, if any. */
  linkedCustomerId: string | null;
  /** The workspace's customers (clients), as the form offers them. */
  customers: ReadonlyArray<{ id: string; name: string }>;
  /** Customers linked to another company of the same CRM account: never this deal's customer by name alone. */
  linkedElsewhere?: ReadonlySet<string>;
  workspace: { shadowOn: boolean };
  today: string;
  /** The CRM's name in copy. */
  label: string;
}): DealPrefill {
  const { deal, customers } = input;
  const notes: string[] = [];

  let customerId = "";
  let customerName = "";
  const linked = input.linkedCustomerId ? customers.find((customer) => customer.id === input.linkedCustomerId) : undefined;
  if (linked) {
    customerId = linked.id;
  } else if (deal.company) {
    const match = counterpartyFor(deal.company.name, customers);
    const plain = (name: string) => name.trim().toLowerCase();
    if (typeof match !== "string" && input.linkedElsewhere?.has(match.id)) {
      // The CRM says this is another company than the one the customer was planned for: the person chooses.
      notes.push(`${match.name} here is linked to another ${input.label} company: choose the customer, or add a new one under another name.`);
    } else if (typeof match !== "string") {
      customerId = match.id;
      if (plain(match.name) !== plain(deal.company.name)) {
        notes.push(`Matched to the customer ${match.name} by its name: check it is the same company as ${deal.company.name} in ${input.label}.`);
      }
    } else if (/matches more than one/.test(match)) {
      notes.push(`More than one customer is named ${deal.company.name}: choose one.`);
    } else {
      customerId = "new";
      customerName = deal.company.name;
      notes.push(`${deal.company.name} is not a customer here yet: it is added as a new customer when you confirm.`);
    }
  }

  const planned = plannedCurrency(deal.currency, input.workspace);
  const currency = planned?.currency ?? "USDC";
  const total = planned ? totalFor(deal.amount, planned.currency) : null;
  const theirs = moneyWords(deal.amount, deal.currency);
  if (planned && total !== null && planned.atPar) {
    notes.push(`${input.label} says ${theirs}: planned as ${formatMinor(Number(total.replace(".", "")), dealDigits(currency))} ${currency}, one for one.`);
  } else if (planned && total === null && deal.amount !== null) {
    notes.push(`${input.label} says ${theirs}, with more decimals than ${currency} takes. Type the total.`);
  } else if (!planned) {
    // A currency Vestiarion never names (VND) is not shown, nor its amount.
    notes.push(theirs && deal.amount !== null && deal.currency ? `${input.label} says ${theirs}. Type the total in USDC.` : "Type the total in USDC.");
  }

  return {
    customerId,
    customerName,
    title: deal.name.slice(0, 120),
    total: total ?? "",
    currency,
    startsOn: deal.closeOn ?? input.today,
    externalRef: deal.reference ?? deal.externalId,
    notes,
  };
}

/** What the Change deal form starts from, for changes made in the CRM (H12). */
export interface ChangePrefill {
  /** The CRM's new amount in the deal's currency, or null to keep the deal's total. */
  total: string | null;
  reason: string;
}

function changeReason(change: CrmChange): string {
  switch (change.what) {
    case "amount": {
      const from = moneyWords(change.from.amount, change.from.currency);
      const to = moneyWords(change.to.amount, change.to.currency);
      return from && to ? `amount ${from} to ${to}` : "amount changed";
    }
    case "close":
      return `close date ${change.from ? dayWords(change.from) : "none"} to ${change.to ? dayWords(change.to) : "none"}`;
    case "stage":
      return change.to === "lost" ? `marked lost${change.label ? ` (${change.label})` : ""}` : `moved back to an open stage${change.label ? ` (${change.label})` : ""}`;
    case "deleted":
      return "deleted there";
  }
}

export function changePrefill(changes: readonly CrmChange[], deal: { currency: string }, label: string): ChangePrefill {
  const amount = changes.find((change): change is Extract<CrmChange, { what: "amount" }> => change.what === "amount");
  // The CRM's new amount is the new total only when it is in the deal's own currency (dollars for USDC, euros for EURC).
  const sameCurrency = amount?.to.currency ? (AT_PAR[amount.to.currency]?.currency ?? amount.to.currency) === deal.currency : false;
  const total = amount && sameCurrency ? totalFor(amount.to.amount, deal.currency) : null;
  const reason = `From ${label}: ${changes.map(changeReason).join("; ")}`;
  return { total, reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason };
}

