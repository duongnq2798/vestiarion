import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { DocumentUploadForm, type DocumentRequestShown } from "@/components/document-requests/DocumentUploadForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import { previewDocumentRequest } from "@/lib/document-requests/intake";
import { DOCUMENT_LINK_INVALID } from "@/lib/document-requests/rules";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Send a document for your invoice",
  robots: { index: false, follow: false },
};

type DocumentRequestPageProps = {
  params: Promise<{ token: string }>;
};

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * Where a document request's link opens (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5). No session:
 * the link is the credential. An open request names the business, the vendor's own invoice number, its amount and due
 * date, and what is missing, with the form to send it; an expired, answered, revoked or unknown link shows one sentence
 * and names no one. Opening it changes nothing, so a mail scanner that follows the link sends nothing. Kept out of
 * search, and out of analytics but for its redacted path.
 */
export default async function DocumentRequestPage({ params }: DocumentRequestPageProps) {
  const { token } = await params;
  let request: DocumentRequestShown | null = null;
  let failed = false;
  try {
    const found = await previewDocumentRequest(token);
    request = found
      ? {
          orgName: found.orgName,
          vendorName: found.vendorName,
          reference: found.reference,
          amount: `${AMOUNT.format(found.amount)} ${found.currency}`,
          dueOn: utcDay(found.dueDate),
          until: utcDay(found.expiresAt),
          missing: found.missing,
        }
      : null;
  } catch {
    console.error("document request preview failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." />
          ) : !request || request.missing.length === 0 ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title={DOCUMENT_LINK_INVALID} />
          ) : (
            <DocumentUploadForm token={token} request={request} />
          )}
        </div>
      </main>
      <SiteFooter compact loop="document_request" />
    </div>
  );
}
