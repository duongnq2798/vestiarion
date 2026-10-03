import { after } from "next/server";
import { withOrg } from "./dal/scope";
import { sendPaymentNotices } from "./payment-notices";

/**
 * Sends the payment notices a person's approval made due, after the response (payment notices R5): the approval is
 * never slower for it. A sandbox has none to send; outside a request, the next cycle sends them.
 */
export function sendNoticesSoon(access: { user: { id: string }; membership: { orgId: string; mode: "sandbox" | "live" } }): void {
  if (access.membership.mode !== "live") return;
  try {
    after(() =>
      withOrg(access.membership.orgId, () => sendPaymentNotices(), { userId: access.user.id }).then(
        () => undefined,
        (error: unknown) => console.error("payment notices after an approval failed", access.membership.orgId, error instanceof Error ? error.message : error)
      )
    );
  } catch {
    // No request scope: the next cycle's notices stage sends it.
  }
}
