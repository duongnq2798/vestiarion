import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge knows Tailwind's default scale, not ours. Without these lists
 * it reads `text-reasoning` (a font size) as a colour and drops it beside
 * `text-ink`, and cannot tell that `shadow-surface` and `shadow-overlay` set
 * the same property.
 */
const merge = extendTailwindMerge<"focus-ring">({
  extend: {
    theme: {
      text: ["reasoning", "eyebrow", "caption", "ui", "body", "lede", "positioning", "section", "display"],
      spacing: ["page", "section"],
      shadow: ["flat", "control", "surface", "raised", "overlay", "brand"],
      "drop-shadow": ["logo"],
      ease: ["standard", "emphasized", "exit"],
      animate: ["arrive", "sweep", "drift", "shimmer"],
    },
    classGroups: {
      duration: [{ duration: ["micro", "overlay", "sheet", "page", "exit", "reveal"] }],
      "focus-ring": ["focus-default", "focus-inverse"],
    },
  },
});

/** Joins class names; of two that set the same property, the later wins. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
