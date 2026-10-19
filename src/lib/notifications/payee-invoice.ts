import { orgHref } from "../auth/org-paths";
import { can } from "../auth/roles";
import { billsHref } from "../bills-view";
import { platformDb, unwrap } from "../dal";
import { payeeInvoiceEmail } from "../email/payee-invoice";
import { sendEmail } from "../email/send";
import { listMembers } from "../platform/members";
import { publicOrigin } from "../public-origin";
import { recordUsageFor } from "../usage/record";

/** Enough for any workspace's owners and admins; a bound so one invoice never fans out without limit. */
const MAX_RECIPIENTS = 10;

/**
 * Tells the members who add or discard a draft (`records.write`: owners and admins) that a payee sent its invoice through
 * its payee link (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P7): one email each, opening Bills'
 * review list. Metered as `payee_invoice`. Best effort: it never throws, logs any send that did not go out, and returns
 * how many did.
 */
export async function notifyPayeeInvoice(input: {
  orgId: string;
  orgName: string;
  payeeName: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
}): Promise<number> {
  try {
    const org = unwrap(await platformDb().from("orgs").select("slug").eq("id", input.orgId).single()) as { slug: string };
    const recipients = (await listMembers(input.orgId)).filter((member) => can(member.role, "records.write")).slice(0, MAX_RECIPIENTS);
    const origin = publicOrigin();
    const email = payeeInvoiceEmail({
      orgName: input.orgName,
      payeeName: input.payeeName,
      invoiceNumber: input.invoiceNumber,
      amount: input.amount,
      dueDate: input.dueDate,
      link: `${origin}${orgHref(org.slug, billsHref({ tab: "bills", review: "captured" }))}`,
      origin,
    });
    const results = await Promise.allSettled(recipients.map((member) => sendEmail({ to: member.email, ...email })));
    let sent = 0;
    for (const result of results) {
      if (result.status === "rejected") console.error("payee invoice: email not sent", String(result.reason));
      else if (!result.value.sent) console.error("payee invoice: email not sent", result.value.reason);
      else sent += 1;
    }
    // Sent outside the workspace's scope, so metered into it here (accountant console U1).
    if (results.length > 0) {
      if (sent > 0) await recordUsageFor(input.orgId, { kind: "email", action: "payee_invoice", provider: "resend", quantity: sent });
      if (sent < results.length) await recordUsageFor(input.orgId, { kind: "email", action: "payee_invoice", provider: "resend", quantity: results.length - sent, ok: false });
    }
    return sent;
  } catch (error) {
    console.error("payee invoice: members not notified", error instanceof Error ? error.message : "unknown error");
    return 0;
  }
}
