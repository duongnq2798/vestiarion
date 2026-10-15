import { NextResponse } from "next/server";
import { hasValidAgentBearer } from "@/lib/agent-security";
import { sweepInvoiceCapture } from "@/lib/invoice-drafts/retention";
import { deleteAbandonedSandboxes, deleteExpiredIdempotencyOutcomes, deleteExpiredWebhookDeliveries } from "@/lib/platform/cleanup";

export const maxDuration = 300;

/**
 * Bearer-protected, run daily by `.github/workflows/sandbox-cleanup.yml` (spec
 * §6, §10 step 5b): abandoned sandboxes, webhook deliveries past their
 * retention (webhooks design W7), the write API's idempotency outcomes past
 * the 24 hours they are given back for (write API R5), and invoice capture's
 * captured text, unsent drafts and ended connections past theirs (invoice
 * capture C9, C10).
 */
export async function POST(request: Request) {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // First, and on their own: they never throw, so a failing sandbox listing
    // below cannot keep expired deliveries or outcomes around.
    const webhooks = await deleteExpiredWebhookDeliveries();
    const idempotency = await deleteExpiredIdempotencyOutcomes();
    // On its own too, and never throws.
    const capture = await sweepInvoiceCapture();
    // Counts only: this body is printed into the workflow's log, and sandbox
    // slugs derive from workspace names. The detail is in the server log.
    const { deleted, failed, hostedUsed, hostedLimit } = await deleteAbandonedSandboxes();
    const failures = failed + webhooks.failed + idempotency.failed + capture.failed;
    return NextResponse.json(
      // The hosted slots in use against the platform's limit (hosted wallets H5): counts only.
      {
        deleted,
        failed: failures,
        webhookDeliveriesDeleted: webhooks.deleted,
        idempotencyOutcomesDeleted: idempotency.deleted,
        hostedUsed,
        hostedLimit,
        invoiceCapture: capture.swept,
      },
      { status: failures > 0 ? 500 : 200 }
    );
  } catch (err) {
    console.error("sandbox cleanup failed", (err as Error).message);
    return NextResponse.json({ error: "cleanup failed" }, { status: 500 });
  }
}
