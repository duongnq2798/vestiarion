import Link from "next/link";
import type { ReactNode } from "react";

/** The static story stays readable when a browser cannot reveal a streamed segment. Open awaits its reads on the server. */
export function EvidencePending({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <div data-live-evidence-loading="" aria-busy="true">{children}</div>
      <noscript>
        <style>{"[data-live-evidence-loading] { display: none; }"}</style>
        <p className="text-sm leading-relaxed text-ink-2">
          <Link href="/open" prefetch={false} className="inline-flex min-h-6 items-center font-semibold text-agent underline underline-offset-4">Read the public payment records</Link>
          {" "}on Open numbers, including recorded figures and transaction links.
        </p>
      </noscript>
    </div>
  );
}
