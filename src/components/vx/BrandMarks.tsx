import { cn } from "@/components/ui/cn";

/**
 * The marks of the services Vestiarion is built on or connects to
 * (docs/superpowers/specs/2026-10-07-brand-marks-design.md): Arc, where
 * payments settle; Circle, whose wallets carry them; Slack and Telegram, where
 * the agent asks and reports; npm, where the SDK is published.
 *
 * Each is its owner's file, served unaltered from public/brands/ in its own
 * colours: no recolouring, cropping or redrawing, as the owners' guidelines
 * ask. A mark is decoration beside its name, never instead of it, so it has an
 * empty alt text; whatever renders it writes the name.
 */

export type Brand = "arc" | "circle" | "slack" | "telegram" | "npm";

const MARKS: Record<Brand, { name: string; file: string; aspect: number; inset?: number; wordmark?: true }> = {
  arc: { name: "Arc", file: "/brands/arc.jpeg", aspect: 1 },
  circle: { name: "Circle", file: "/brands/circle.svg", aspect: 1 },
  // Slack's symbol file keeps its clear space around the mark: 73.6 of 270 on each side.
  slack: { name: "Slack", file: "/brands/slack.svg", aspect: 1, inset: 73.6 / 270 },
  telegram: { name: "Telegram", file: "/brands/telegram.svg", aspect: 1 },
  npm: { name: "npm", file: "/brands/npm.svg", aspect: 18 / 7, wordmark: true },
};

/** The files every mark is served from, for the tests that hold them to their owners' originals. */
export const BRAND_FILES: Readonly<Record<Brand, string>> = Object.fromEntries(Object.entries(MARKS).map(([brand, mark]) => [brand, mark.file])) as Record<Brand, string>;

/** True when the mark spells the name itself (npm's), so the name beside it is for screen readers only. */
export const isWordmark = (brand: Brand) => MARKS[brand].wordmark === true;

/**
 * A brand's mark, `size` pixels tall. A file that carries clear space around
 * its mark is drawn larger and pulled in by the same amount, so every mark
 * shows at the same height without cutting the owner's file.
 */
export function BrandMark({ brand, size = 16, className }: { brand: Brand; size?: number; className?: string }) {
  const mark = MARKS[brand];
  const box = size / (1 - 2 * (mark.inset ?? 0));
  const pull = (size - box) / 2;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small static mark; next/image adds nothing for an SVG
    <img
      src={mark.file}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      width={Math.round(box * mark.aspect)}
      height={Math.round(box)}
      data-brand={brand}
      className={cn("shrink-0 select-none", className)}
      style={pull ? { margin: pull } : undefined}
    />
  );
}
