import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A data table that scrolls sideways inside its own frame on a narrow screen.
 * `containerClassName` styles that frame — give it a max height and
 * `overflow-auto` for a sticky header over a long list. The frame is
 * `relative` so screen-reader-only text and hidden form controls in the
 * cells scroll with the table instead of widening the page.
 */
export function Table({ className, containerClassName, label, ...props }: ComponentProps<"table"> & { containerClassName?: string; label?: string }) {
  return (
    <div
      className={cn("relative w-full overflow-x-auto", label && "rounded-lg", containerClassName)}
      {...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
    >
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-line [&>tr]:transition-colors [&>tr]:duration-150 [&>tr]:ease-standard [&>tr:hover]:bg-raised/40", className)} {...props} />;
}

export function TableRow(props: ComponentProps<"tr">) {
  return <tr {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th scope="col" className={cn("whitespace-nowrap px-4 py-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 align-middle text-ink", className)} {...props} />;
}
