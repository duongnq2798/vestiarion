import { cva } from "class-variance-authority";

/** A filter pill that is a link. `selected` marks the filter in force; pair it with `aria-current`. */
export const chipVariants = cva(
  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-standard sm:h-7 sm:px-2.5 [&_svg]:size-2.5 [&_svg]:shrink-0",
  {
    variants: {
      selected: {
        true: "border-ink-3 bg-raised text-ink",
        false: "border-line bg-surface/60 text-ink-2 hover:border-line-strong hover:text-ink",
      },
    },
    defaultVariants: { selected: false },
  }
);
