import { can, type OrgRole } from "../auth/roles";
import type { RequestKind } from "../customer-portal/model";
import { platformDb, unwrap } from "../dal";
import { customerPreview, customerWroteEmail } from "../email/customer-wrote";
import { emailSettingsFromEnv, sendEmail } from "../email/send";
import { listMembers } from "../platform/members";
import { publicOrigin } from "../public-origin";

/**
 * Telling the members who answer customers that a customer wrote on its statement link
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P8): the owners and admins (`records.write`, who reply and
 * close) whose email switch (`memberships.notify_email`, the one in Settings' Notifications) is on, each a message of
 * their own, with a short preview of the words and a link to From customers. How often is the database's: 0109's
 * functions say `notify` at most once an hour per request, so a long thread sends one email an hour at most.
 *
 * Best effort: it never throws, logs what did not go out without an address, and returns how many went.
 */

/** Enough for any workspace's owners and admins; a bound so one message never fans out without limit. */
export const CUSTOMER_NOTICE_MAX_RECIPIENTS = 10;

const ROLE_ORDER: readonly OrgRole[] = ["owner", "admin"];

export interface CustomerWroteNotice {
  orgId: string;
  customerName: string;
  kind: RequestKind;
  /** Words added under a request already open, rather than a new request. */
  more: boolean;
  /** What the customer wrote, if anything: only a short preview of it is sent. */
  words: string | null;
}

/** The members who may answer a customer and get email, owners first, then by address; at most ten. */
async function answeringRecipients(orgId: string): Promise<string[]> {
  const members = await listMembers(orgId);
  const switches = unwrap(await platformDb().from("memberships").select("user_id, notify_email").eq("org_id", orgId)) as Array<{ user_id: string; notify_email: boolean }>;
  const switchedOn = new Set(switches.filter((row) => row.notify_email === true).map((row) => row.user_id));
  return members
    .filter((member) => can(member.role, "records.write") && switchedOn.has(member.userId))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
    .slice(0, CUSTOMER_NOTICE_MAX_RECIPIENTS)
    .map((member) => member.email);
}

export async function notifyCustomerWrote(notice: CustomerWroteNotice): Promise<number> {
  try {
    const settings = emailSettingsFromEnv();
    if (!settings) return 0;
    const org = unwrap(await platformDb().from("orgs").select("name, slug").eq("id", notice.orgId).single()) as { name: string; slug: string };
    const recipients = await answeringRecipients(notice.orgId);
    if (recipients.length === 0) return 0;
    const origin = publicOrigin();
    const email = customerWroteEmail({
      orgName: org.name,
      customerName: notice.customerName,
      kind: notice.kind,
      more: notice.more,
      preview: customerPreview(notice.words),
      link: `${origin}/o/${org.slug}/invoices?tab=receivables#from-customers`,
      origin,
    });
    const results = await Promise.allSettled(recipients.map((to) => sendEmail({ to, ...email }, settings)));
    let sent = 0;
    for (const result of results) {
      if (result.status === "rejected") console.error("customer wrote: email not sent", notice.orgId, result.reason instanceof Error ? result.reason.name : "unknown");
      else if (!result.value.sent) console.error("customer wrote: email not sent", notice.orgId, result.value.reason);
      else sent += 1;
    }
    return sent;
  } catch (error) {
    console.error("customer wrote: members not told", notice.orgId, error instanceof Error ? error.message : "unknown");
    return 0;
  }
}
