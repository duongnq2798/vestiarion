"use client";

import { Ban, FileDown } from "lucide-react";
import { revokeDocumentRequestAction, type DocumentRequestsActionResult } from "@/app/actions/document-requests";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { useActionForm } from "@/components/ui/useActionForm";
import { cn } from "@/components/ui/cn";
import {
  documentCheckLine,
  documentFileHref,
  documentKindWord,
  documentRequestLine,
  type DocumentReceivedView,
  type DocumentRequestView,
} from "@/lib/document-requests/rules";

const INITIAL: DocumentRequestsActionResult = { ok: false, message: "" };

function RevokeForm({ orgSlug, requestId, vendorName }: { orgSlug: string; requestId: string; vendorName: string }) {
  const formId = `revoke-document-request-${requestId}`;
  const { state, pending, formProps } = useActionForm(revokeDocumentRequestAction, INITIAL, { toastOnSuccess: true });
  return (
    <form id={formId} {...formProps} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="requestId" value={requestId} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="secondary" size="sm" icon={<Ban />} loading={pending}>
            Revoke
          </Button>
        }
        title="Revoke this request?"
        description={`The link sent to ${vendorName} stops working at once, and Vestiarion does not ask them about this bill again.`}
        confirmLabel="Revoke the link"
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/**
 * What the cycle's check found in the document, under its headline (document checks DK13): nothing before migration
 * 0144, nor while vendor requests are off and the document waits.
 */
function CheckLine({ view, vendorName, goodsReceived }: { view: DocumentReceivedView; vendorName: string; goodsReceived: boolean }) {
  if (!view.check) return null;
  return (
    <p className="text-ink-2" data-document-check={view.check.outcome}>
      {documentCheckLine(view.check, vendorName, goodsReceived)}
    </p>
  );
}

/** What the vendor sent: the purchase order number and note they typed, and a members-only link to open the file. */
function Received({ orgSlug, view }: { orgSlug: string; view: DocumentReceivedView }) {
  return (
    <>
      {(view.poReference || view.note) && (
        <dl className="grid gap-1 text-xs">
          {view.poReference && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-3">Purchase order they typed</dt>
              <dd className="font-mono break-all text-ink">{view.poReference}</dd>
            </div>
          )}
          {view.note && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-3">Their note</dt>
              <dd className="min-w-0 whitespace-pre-line break-words text-ink">{view.note}</dd>
            </div>
          )}
        </dl>
      )}
      {view.id && (
        <Button asChild size="sm" variant="secondary">
          <a href={documentFileHref(orgSlug, view.id)} rel="noopener noreferrer">
            <FileDown aria-hidden />
            Open the {documentKindWord(view.fileType)}
          </a>
        </Button>
      )}
    </>
  );
}

/**
 * What a bill's card says of the agent's request to its vendor for the missing document
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER3, ER4, ER6), on Approvals and on Bills: what it would
 * ask, in shadow; when it asked and when the link expires, with Revoke for an owner or admin (`canRevoke`); what the
 * vendor sent, with a members-only link to open it and the purchase order number and note they typed; or a link that
 * expired unanswered. What the vendor sent with an earlier request (`received`) stays under a newer one. A document a
 * member attached says so, and each document says what the cycle's check found in it
 * (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK13), as the bill's goods stand now
 * (`goodsReceived`): with vendor requests on, a match adds the purchase order and a person approves the payment; anything
 * else leaves the bill as it is, and the purchase order the vendor typed is offered in Add details. Nothing here changes
 * the bill.
 */
export function DocumentRequestLine({
  orgSlug,
  vendorName,
  view,
  goodsReceived,
  canRevoke = false,
  className,
}: {
  orgSlug: string;
  vendorName: string;
  view: DocumentRequestView;
  /** Whether the bill's goods are marked received now: a match's line says what is left for the team (DK6). */
  goodsReceived: boolean;
  canRevoke?: boolean;
  className?: string;
}) {
  const sentence = documentRequestLine(view, vendorName);
  const received = view.state === "answered" ? null : (view.received ?? null);
  return (
    <div className={cn("space-y-2 rounded-lg border border-line bg-raised px-3 py-2 text-sm", className)} data-document-request={view.state}>
      <p className="text-ink-2">{sentence}</p>
      {view.state === "answered" && <CheckLine view={view} vendorName={vendorName} goodsReceived={goodsReceived} />}
      {view.state === "answered" && <Received orgSlug={orgSlug} view={view} />}
      {view.state === "asked" && canRevoke && view.id && <RevokeForm orgSlug={orgSlug} requestId={view.id} vendorName={vendorName} />}
      {received && (
        <div className="space-y-2 border-t border-line pt-2" data-document-received>
          <p className="text-ink-2">{documentRequestLine(received, vendorName)}</p>
          <CheckLine view={received} vendorName={vendorName} goodsReceived={goodsReceived} />
          <Received orgSlug={orgSlug} view={received} />
        </div>
      )}
    </div>
  );
}
