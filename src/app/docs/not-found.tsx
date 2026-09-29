import Link from "next/link";
import { DocsSearchAction } from "@/components/docs/DocsSearch";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";

/** A `/docs` address that matches no page, inside the docs frame so the sidebar and search are still there. */
export default function DocsNotFound() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center py-16">
      <div className="w-full max-w-md text-center">
        <p>
          <Eyebrow className="text-agent">404</Eyebrow>
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">This page does not exist</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">The address may be mistyped, or the page may have moved. Search the docs for it.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <DocsSearchAction />
          <Button asChild variant="secondary">
            <Link href="/docs">Go to the docs</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
