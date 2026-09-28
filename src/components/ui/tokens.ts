/**
 * The token values TypeScript needs, copied from `src/app/globals.css`.
 * `tests/ui-tokens.test.ts` reads both and fails if they drift apart.
 */

/** `--color-surface`: the browser chrome colour on phones. */
export const THEME_COLOR = "#fffefa";

export const MOTION = {
  /** `--ease-*`, as cubic-bezier control points. */
  ease: {
    standard: [0.2, 0.7, 0.2, 1],
    emphasized: [0.16, 1, 0.3, 1],
    exit: [0.4, 0, 1, 1],
  },
  /** Seconds, the unit Motion takes. */
  duration: {
    micro: 0.15,
    overlay: 0.2,
    sheet: 0.3,
    page: 0.42,
    exit: 0.18,
    reveal: 0.45,
  },
  /** Shared-layout indicators: quick to settle, no bounce. */
  spring: { type: "spring", stiffness: 500, damping: 40 },
  stagger: 0.06,
} as const;
