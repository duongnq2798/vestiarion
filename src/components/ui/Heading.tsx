import type { ComponentProps } from "react";
import { cn } from "./cn";

const SIZE = {
  positioning: "text-positioning",
  display: "text-display",
  section: "text-section",
} as const;

export type HeadingProps = ComponentProps<"h2"> & {
  /** The page chooses its heading hierarchy independently of the visual size. */
  as?: "h1" | "h2" | "h3" | "p";
  size?: keyof typeof SIZE;
};

/** Public-page typography that inherits the surrounding section's text color. */
export function Heading({ as: Comp = "h2", size = "section", className, ...props }: HeadingProps) {
  return <Comp className={cn("font-semibold", SIZE[size], className)} {...props} />;
}
