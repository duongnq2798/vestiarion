import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";

/** A section of /open: a small caption saying whose figures, the heading, and what it shows. */
export function SectionHead({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div>
      <Eyebrow className="text-xs">{eyebrow}</Eyebrow>
      <h3 id={id} className="mt-2 text-[1.375rem] font-semibold tracking-tight text-ink sm:text-[1.625rem]">
        {title}
      </h3>
      {children && <p className="mt-2 max-w-3xl text-[0.9375rem] leading-7 text-ink-2">{children}</p>}
    </div>
  );
}
