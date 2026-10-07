import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";

/** A section of /open: a small caption saying whose figures, the heading, and what it shows. */
export function SectionHead({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 id={id} className="mt-1.5 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
        {title}
      </h3>
      {children && <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-2">{children}</p>}
    </div>
  );
}
