import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";

/** A `/docs` address that matches no page, inside the docs frame so the sidebar is still there. */
export default function DocsNotFound() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center py-16">
      <div className="w-full max-w-md text-center">
        <p>
          <Eyebrow className="text-agent">404</Eyebrow>
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">This page does not exist</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">The address may be mistyped, or the page may have moved.</p>
        <div className="mt-8 flex justify-center">
          <Button asChild>
            <Link href="/docs">Go to the docs</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
