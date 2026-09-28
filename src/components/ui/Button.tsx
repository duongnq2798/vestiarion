import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

/**
 * One button for the whole product. Variants name intent, not colour:
 * `primary` is the one thing a screen wants done, `danger` removes or
 * refuses, `inverse` sits on an agent-blue band, `link` reads as text.
 */
export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap font-semibold",
    "transition duration-150 ease-standard",
    "disabled:pointer-events-none disabled:opacity-60 aria-busy:cursor-progress",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-agent text-on-agent shadow-brand hover:-translate-y-px hover:bg-agent/95 active:translate-y-0 active:scale-[0.98]",
        secondary: "border border-line-strong bg-surface text-ink shadow-control hover:border-agent-line hover:text-agent active:scale-[0.98]",
        ghost: "text-ink-2 hover:bg-raised/70 hover:text-ink active:bg-raised",
        danger: "border border-refused-line bg-surface text-refused hover:bg-refused-soft active:scale-[0.98]",
        "danger-solid": "bg-refused text-on-agent shadow-control hover:bg-refused/90 active:scale-[0.98]",
        inverse: "bg-surface text-agent hover:-translate-y-px active:translate-y-0 active:scale-[0.98]",
        link: "gap-1 rounded-md text-sm font-medium text-agent underline-offset-4 hover:underline [&_svg]:size-3.5",
      },
      size: {
        sm: "h-8 rounded-lg px-3 text-xs [&_svg]:size-3.5",
        md: "h-11 rounded-xl px-4 text-sm sm:h-10 [&_svg]:size-4",
        lg: "h-12 rounded-xl px-5 text-[0.9375rem] [&_svg]:size-[1.125rem]",
        icon: "size-11 rounded-xl sm:size-10 [&_svg]:size-[1.125rem]",
        "icon-sm": "size-8 rounded-lg [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Renders the child element — a `Link`, an `<a>` — with the button’s look instead of a `<button>`. */
    asChild?: boolean;
    /** Disables the button, marks it busy and shows a spinner in the leading icon’s place. */
    loading?: boolean;
    /** A leading icon. */
    icon?: ReactNode;
  };

const ICON_ONLY = new Set(["icon", "icon-sm"]);

export function Button({ className, variant, size, asChild = false, loading = false, icon, type, disabled, children, ...props }: ButtonProps) {
  const iconOnly = size != null && ICON_ONLY.has(size);
  if (process.env.NODE_ENV !== "production" && iconOnly && !props["aria-label"] && !props["aria-labelledby"]) {
    console.error("Button: an icon-only button needs an aria-label, or it has no accessible name.");
  }
  // A link reads as text: it takes no height or padding from a size.
  const classes = cn(buttonVariants({ variant, size: variant === "link" ? null : size }), className);

  if (asChild) {
    return (
      <Slot.Root className={classes} {...(props as ComponentProps<typeof Slot.Root>)}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button type={type ?? "button"} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Spinner /> : icon}
      {loading && iconOnly ? null : children}
    </button>
  );
}
