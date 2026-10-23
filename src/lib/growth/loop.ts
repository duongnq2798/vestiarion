/**
 * The counterparty loop (docs/superpowers/specs/2026-10-19-counterparty-loop-design.md C1-C3): the pages and emails a
 * business sends its suppliers, payees and customers link back to Vestiarion, tagged with the kind of page only. Pure
 * data, safe in client components and emails.
 */

/** The campaign every link of the loop carries; a workspace opened from one shows it as its first touch's. */
export const LOOP_CAMPAIGN = "counterparty_loop";

/** The public pages a counterparty opens (C1). */
export const LOOP_PAGES = [
  "supplier_status",
  "payee_link",
  "receipt",
  "early_offer",
  "customer_discount",
  "more_time",
  "pay_link",
  "statement",
  "shared_report",
  "document_request",
] as const;
export type LoopPage = (typeof LOOP_PAGES)[number];

/** The emails a counterparty gets (C1). */
export const LOOP_EMAILS = ["payment_notice", "payee_link", "address_request", "early_offer", "term_request", "customer_discount", "receivable_reminder", "document_request"] as const;
export type LoopEmail = (typeof LOOP_EMAILS)[number];

/** The words on a page's foot and in an email's (C2). */
export const LOOP_PAGE_LINE = "Sent with Vestiarion, the AI agent for bills and payments.";
export const LOOP_PAGE_LINK = "Try it on your own bills";
export const LOOP_EMAIL_LINE = "Run your own bills with it:";

/** The page's link as the analytics click names it: `loop-` and the kind, hyphens only (`CTA_ID`). */
export function loopCtaId(page: LoopPage): string {
  return `loop-${page.replaceAll("_", "-")}`;
}

function tagged(base: string, source: string, medium: "counterparty_page" | "counterparty_email"): string {
  const query = new URLSearchParams({ utm_source: source, utm_medium: medium, utm_campaign: LOOP_CAMPAIGN });
  return `${base}/?${query.toString()}`;
}

/** The landing page, tagged with the kind of page it was reached from: a path, for a link on our own site. */
export function loopPageHref(page: LoopPage): string {
  return tagged("", page, "counterparty_page");
}

/** The landing page at `origin`, tagged with the kind of email it was reached from. */
export function loopEmailUrl(origin: string, email: LoopEmail): string {
  return tagged(origin.replace(/\/+$/, ""), email, "counterparty_email");
}
