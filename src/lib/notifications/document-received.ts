import { approvalAnchor, orgHref } from "../auth/org-paths";
import { can } from "../auth/roles";
import { documentReceivedEmail } from "../email/document-received";
import { sendEmail } from "../email/send";
import { listMembers } from "../platform/members";
import { publicOrigin } from "../public-origin";
import { recordUsageFor } from "../usage/record";

/** Enough for any workspace's owners and admins; a bound so one document never fans out without limit. */
const MAX_RECIPIENTS = 10;

/**
 * Tells the members who add a bill's details (`records.write`: owners and admins) that its vendor sent a document through
 * a request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5, ER6): one email each, opening the
 * bill's card in Approvals. Metered as `document_received`. Best effort: it never throws, logs any send that did not go
 * out, and returns how many did.
 */
export async function notifyDocumentReceived(input: {
  orgId: string;
  orgName: string;
  slug: string;
  invoiceId: string;
  vendorName: string;
  reference: string | null;
  /** Whether the vendor typed a purchase order number; the email says so, never what they typed. */
  typedPo: boolean;
  /** How the cycle checks the document (document checks DK1): in shadow or on; null while off, or before migration 0144. */
  checks?: "shadow" | "on" | null;
}): Promise<number> {
  try {
    const recipients = (await listMembers(input.orgId)).filter((member) => can(member.role, "records.write")).slice(0, MAX_RECIPIENTS);
    const origin = publicOrigin();
    const email = documentReceivedEmail({
      orgName: input.orgName,
      vendorName: input.vendorName,
      reference: input.reference,
      typedPo: input.typedPo,
      checks: input.checks ?? null,
      link: `${origin}${orgHref(input.slug, `/approvals#${approvalAnchor(input.invoiceId)}`)}`,
      origin,
    });
    const results = await Promise.allSettled(recipients.map((member) => sendEmail({ to: member.email, ...email })));
    let sent = 0;
    for (const result of results) {
      if (result.status === "rejected") console.error("document received: email not sent", String(result.reason));
      else if (!result.value.sent) console.error("document received: email not sent", result.value.reason);
      else sent += 1;
    }
    // Sent outside the workspace's scope, so metered into it here (accountant console U1).
    if (results.length > 0) {
      if (sent > 0) await recordUsageFor(input.orgId, { kind: "email", action: "document_received", provider: "resend", quantity: sent });
      if (sent < results.length) await recordUsageFor(input.orgId, { kind: "email", action: "document_received", provider: "resend", quantity: results.length - sent, ok: false });
    }
    return sent;
  } catch (error) {
    console.error("document received: members not told", error instanceof Error ? error.message : "unknown error");
    return 0;
  }
}
