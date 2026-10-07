import { BookOpen } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * A section's link to the docs page that explains it, beside its heading, as API keys and Webhooks have it: the book
 * and "Docs", named for screen readers by what the page explains. `tests/docs-links.test.tsx` holds every one to a
 * page, and a heading, the docs have.
 */
export function DocsLink({ href, topic }: { href: string; topic: string }) {
  return (
    <Button asChild variant="link">
      <Link href={href} aria-label={`Docs: ${topic}`}>
        <BookOpen aria-hidden />
        Docs
      </Link>
    </Button>
  );
}
