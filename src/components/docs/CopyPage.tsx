import { FileText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { docsMarkdownPath } from "@/lib/docs/paths";

/**
 * "Copy page" and the page's Markdown view, in the page header. The Markdown
 * is the page's `.md` view, written on the server when the page is built and
 * passed in, so copying needs no request. The view is a plain link: it is a
 * document, not a page the router renders.
 */
export function CopyPage({ slug, markdown }: { slug: string; markdown: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <CopyButton value={markdown} label="Copy this page as Markdown" variant="secondary" size="sm">
        Copy page
      </CopyButton>
      <Button asChild variant="ghost" size="sm">
        <a href={docsMarkdownPath(slug)} aria-label="View this page as Markdown">
          <FileText aria-hidden />
          <span className="hidden sm:inline">Markdown</span>
        </a>
      </Button>
    </div>
  );
}
