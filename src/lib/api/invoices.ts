/**
 * The values `GET /api/v1/invoices` accepts for its `direction` and `status`
 * filters. Kept here rather than in the route so the OpenAPI document can
 * import the same lists the route validates against.
 */
export const INVOICE_DIRECTIONS = ["payable", "receivable"] as const;
export const INVOICE_STATUSES = [
  "pending", "matched", "scheduled", "paid", "held", "flagged", "awaiting_info", "received", "rejected",
] as const;
