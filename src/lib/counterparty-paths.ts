/**
 * Links to a counterparty's page and to a milestone's row (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL15, CL16). Pure, with no imports, so a page, a client component, an email and a chat notice write the same path. Each
 * path is the organization's own, given to `orgHref`.
 */

/**
 * The page's anchored parts, in the order it shows them (CL1): Profile, then the lines inside it a link may open at, then
 * the address and the rest. The payee link, milestones and documents are a payee's only.
 */
export const COUNTERPARTY_SECTIONS = [
  "profile",
  "screening",
  "limit",
  "billing-email",
  "purchase-orders",
  "address",
  "payee-link",
  "milestones",
  "bills",
  "payments",
  "documents",
  "history",
] as const;
export type CounterpartySection = (typeof COUNTERPARTY_SECTIONS)[number];

/** CL15: a counterparty's page, at one of its parts when one is named; the Counterparties list for no id. */
export function counterpartyPath(id: string, section?: CounterpartySection): string {
  if (id === "") return "/counterparties";
  return `/counterparties/${encodeURIComponent(id)}${section ? `#${section}` : ""}`;
}

/** CL16: the counterparty's row on the Counterparties list, which a link opens (`ScrollToHash`), as old bookmarks do. */
export function counterpartyRowPath(id: string): string {
  return `/counterparties#counterparty-${id}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * CL2: the page's id, lowercased, when it is a UUID; null for anything else, which the page answers with a 404 before it
 * reads anything.
 */
export function counterpartyIdOf(param: string): string | null {
  const id = param.toLowerCase();
  return UUID.test(id) ? id : null;
}

/** CL15: the id of a milestone's row on Contractors, which a link opens at. */
export function milestoneAnchor(id: string): string {
  return `milestone-${id}`;
}

/**
 * CL15: a milestone's row on Contractors. Paid and closed milestones are listed past their latest 10 only with Show all,
 * so the link for one (`paid`, for a closed one too) asks for every row.
 */
export function milestoneRowPath(id: string, { paid }: { paid: boolean }): string {
  return `/contractors${paid ? "?history=all" : ""}#${milestoneAnchor(id)}`;
}
