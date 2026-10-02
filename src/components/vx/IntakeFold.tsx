import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";

/**
 * A page's way to add something (New invoice, New payment, Add counterparty), folded until it is needed: the
 * pages lead with their work, and the form is one click away. A page opens it by default while it has nothing
 * yet, where adding is the next step. A `<details>`: it works before JavaScript runs.
 */
export function IntakeFold({ label, meta, defaultOpen, className = "mb-8", children }: { label: string; meta: string; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  return (
    <Disclosure
      className={className}
      defaultOpen={defaultOpen}
      summary={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="inline-flex items-center gap-1.5 text-ink">
            <Plus aria-hidden className="size-4" />
            {label}
          </span>
          <span className="text-[0.8125rem] font-normal text-ink-3">{meta}</span>
        </span>
      }
    >
      {children}
    </Disclosure>
  );
}
