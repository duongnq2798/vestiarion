import { can } from "../auth/roles";
import { platformDb, unwrap } from "../dal";
import { payeeAddressEmail } from "../email/payee-address";
import { sendEmail } from "../email/send";
import { listMembers } from "../platform/members";
import { publicOrigin } from "../public-origin";

/** Enough for any workspace's approvers; a bound so one submission never fans out without limit. */
const MAX_RECIPIENTS = 10;

/**
 * Tells the people who can confirm addresses that a payee added theirs
 * through a link (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md
 * §2, R4): until one of them confirms it, nothing is paid to it, and before
 * this nobody knew it had arrived. Best effort (R7): it never throws, logs any
 * send that did not go out, and returns how many did.
 */
export async function notifyPayeeAddress(input: { orgId: string; orgName: string; payeeName: string; address: string }): Promise<number> {
  try {
    const org = unwrap(await platformDb().from("orgs").select("slug").eq("id", input.orgId).single()) as { slug: string };
    const recipients = (await listMembers(input.orgId)).filter((member) => can(member.role, "approval.decide")).slice(0, MAX_RECIPIENTS);
    const origin = publicOrigin();
    const email = payeeAddressEmail({
      orgName: input.orgName,
      payeeName: input.payeeName,
      address: input.address,
      link: `${origin}/o/${org.slug}/counterparties`,
      origin,
    });
    const results = await Promise.allSettled(recipients.map((member) => sendEmail({ to: member.email, ...email })));
    let sent = 0;
    for (const result of results) {
      if (result.status === "rejected") console.error("payee address: email not sent", String(result.reason));
      else if (!result.value.sent) console.error("payee address: email not sent", result.value.reason);
      else sent += 1;
    }
    return sent;
  } catch (error) {
    console.error("payee address: approvers not notified", error instanceof Error ? error.message : error);
    return 0;
  }
}
