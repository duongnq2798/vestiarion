import { after } from "next/server";
import { withOrg } from "./dal/scope";
import { sendPullRequestComments } from "./github/payment-comments";
import { sendPaymentNotices } from "./payment-notices";

/**
 * Sends what a person's approval made due, after the response (payment notices R5): the payee's email, and the comment
 * on the pull request a milestone was paid for (GitHub App design G4). The approval is never slower for either, and one
 * failing never stops the other. A sandbox has none to send; outside a request, the next cycle sends them.
 */
export function sendNoticesSoon(access: { user: { id: string }; membership: { orgId: string; mode: "sandbox" | "live" } }): void {
  if (access.membership.mode !== "live") return;
  try {
    after(() =>
      withOrg(
        access.membership.orgId,
        async () => {
          await sendPaymentNotices().catch((error: unknown) =>
            console.error("payment notices after an approval failed", access.membership.orgId, error instanceof Error ? error.message : error)
          );
          await sendPullRequestComments().catch((error: unknown) =>
            console.error("pull request comments after an approval failed", access.membership.orgId, error instanceof Error ? error.message : error)
          );
        },
        { userId: access.user.id }
      ).then(
        () => undefined,
        (error: unknown) => console.error("payment notices after an approval failed", access.membership.orgId, error instanceof Error ? error.message : error)
      )
    );
  } catch {
    // No request scope: the next cycle's notices stage sends it.
  }
}
