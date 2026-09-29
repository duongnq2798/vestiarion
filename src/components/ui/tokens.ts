/**
 * The token values TypeScript needs, copied from `src/app/globals.css`.
 * `tests/ui-tokens.test.ts` reads both and fails if they drift apart.
 */

/** CSS palette values needed by non-CSS renderers such as `next/og`. */
export const COLOR = {
  ground: "#f3f0e7",
  surface: "#fffefa",
  raised: "#e9e5d9",
  line: "#ddd8ca",
  lineStrong: "#bbb5a7",
  ink: "#18211c",
  ink2: "#4d5a53",
  ink3: "#646c67",
  agent: "#3048c9",
  agentSoft: "#e9edff",
  agentLine: "#aeb9f6",
  proof: "#11765a",
  proofSoft: "#e2f4ec",
  proofLine: "#9bcfbd",
  held: "#9f5b08",
  heldSoft: "#fff1cf",
  heldLine: "#e2bd70",
  refused: "#bc3e2f",
  refusedSoft: "#ffe8e2",
  refusedLine: "#efa69a",
} as const;

/** `--color-surface`: the browser chrome colour on phones. */
export const THEME_COLOR = COLOR.surface;

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
