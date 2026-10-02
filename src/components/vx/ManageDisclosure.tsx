import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";

/**
 * The foot of a console panel whose explanation and form are rarely needed (Gateway, the service budget): closed
 * by default, so the panel shows its figure and nothing else until someone opens it. A `<details>`: it works before
 * JavaScript runs and opens for find-in-page.
 */
export function ManageDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Disclosure
      variant="bare"
      className="border-t border-line"
      summaryClassName="flex items-center gap-1.5 px-4 py-3 text-[0.8125rem] font-medium text-ink-2 transition-colors duration-150 ease-standard hover:text-ink sm:px-5"
      summary={
        <>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
          {label}
        </>
      }
    >
      {children}
    </Disclosure>
  );
}
