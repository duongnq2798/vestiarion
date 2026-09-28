import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

const avatarVariants = cva("grid shrink-0 select-none place-items-center font-semibold uppercase", {
  variants: {
    tone: {
      ink: "bg-ink text-ground",
      agent: "border border-agent-line bg-agent-soft text-agent",
    },
    shape: {
      circle: "rounded-full",
      square: "rounded-lg",
    },
    size: {
      sm: "size-7 text-xs",
      md: "size-8 text-xs",
      lg: "size-9 text-sm",
    },
  },
  defaultVariants: { tone: "ink", shape: "circle", size: "md" },
});

/**
 * An initial in a shape: people are circles, workspaces are rounded squares.
 * Decorative — the name is always written beside it.
 */
export function Avatar({ name, tone, shape, size, className }: VariantProps<typeof avatarVariants> & { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(avatarVariants({ tone, shape, size }), className)}>
      {[...name.trim()][0] ?? "?"}
    </span>
  );
}
