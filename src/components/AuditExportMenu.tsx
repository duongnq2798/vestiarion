import { Download, FileJson, FileSpreadsheet } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * The Audit page's export (audit-export spec §1): the signed JSON that the
 * standalone verifier checks, and a CSV for spreadsheets. Plain links with
 * `download`: the route answers with an attachment, for any member.
 */
export function AuditExportMenu({ orgSlug }: { orgSlug: string }) {
  const href = (format: "json" | "csv") => `/api/ledger/export?org=${encodeURIComponent(orgSlug)}&format=${format}`;
  return (
    <div role="group" aria-labelledby="audit-export-label" className="flex flex-wrap items-center gap-2">
      <span id="audit-export-label" className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-3">
        <Download aria-hidden className="size-3.5" />
        Download
      </span>
      <Button asChild size="sm" variant="secondary">
        <a href={href("json")} download>
          <FileJson aria-hidden />
          Signed JSON
        </a>
      </Button>
      <Button asChild size="sm" variant="secondary">
        <a href={href("csv")} download>
          <FileSpreadsheet aria-hidden />
          CSV
        </a>
      </Button>
      <Button asChild variant="link" size="sm">
        <Link href="/docs/guides/audit-export">How to check a file</Link>
      </Button>
    </div>
  );
}
