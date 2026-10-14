import { cn } from "@/components/ui/cn";
import type { ProviderId } from "@/lib/connectors/provider";

/**
 * The marks of the services Vestiarion is built on or connects to
 * (docs/superpowers/specs/2026-10-07-brand-marks-design.md,
 * docs/superpowers/specs/2026-10-12-integration-marks-design.md): Arc, where
 * payments settle; Circle, whose wallets carry them; Slack and Telegram, where
 * the agent asks and reports; npm, where the SDK is published; Xero and
 * QuickBooks Online, whose bills come in; HubSpot, whose won deals come in.
 *
 * Each is its owner's file, served unaltered from public/brands/ in its own
 * colours: no recolouring, cropping or redrawing, as the owners' guidelines
 * ask. The one exception is QuickBooks' symbol: the green "qb" circle of
 * Intuit's QuickBooks lockup, its two paths copied from the lockup as they are,
 * in a file of its own (tests/brand-marks.test.tsx holds them to the lockup's).
 * A mark is decoration beside its name, never instead of it, so it has an
 * empty alt text; whatever renders it writes the name.
 *
 * Every mark is an `<img>`: each file is its own document, so the ids inside
 * one (the lockup's clip paths) never meet another mark's or the page's.
 */

export type Brand = "arc" | "circle" | "slack" | "telegram" | "npm" | "xero" | "quickbooks" | "quickbooks-lockup" | "hubspot";

/**
 * `aspect` is the file's width over its height. `inset` is clear space the file carries on every side, as a share of
 * its height. `scale` draws a mark that much taller or shorter than `size`, in proportion: Xero's wordmark, whose
 * lowercase letters fill its file, shorter, so they stand as tall as a name beside them; QuickBooks' lockup taller, so
 * its circle is as tall as the other symbols.
 */
const MARKS: Record<Brand, { name: string; file: string; aspect: number; inset?: number; scale?: number; wordmark?: true }> = {
  arc: { name: "Arc", file: "/brands/arc.jpeg", aspect: 1 },
  circle: { name: "Circle", file: "/brands/circle.svg", aspect: 1 },
  // Slack's symbol file keeps its clear space around the mark: 73.6 of 270 on each side.
  slack: { name: "Slack", file: "/brands/slack.svg", aspect: 1, inset: 73.6 / 270 },
  telegram: { name: "Telegram", file: "/brands/telegram.svg", aspect: 1 },
  npm: { name: "npm", file: "/brands/npm.svg", aspect: 18 / 7, wordmark: true },
  // Xero's wordmark in midnight, the colour Xero sets on a light ground (its bright blue sits on midnight). The kit
  // has no symbol apart from the word, whose lowercase letters fill the file: drawn at three quarters of the height.
  xero: { name: "Xero", file: "/brands/xero.svg", aspect: 210 / 60, scale: 0.75, wordmark: true },
  // QuickBooks' symbol, the green "qb" circle, for small places: a Settings card's heading, the connect and launch pages.
  quickbooks: { name: "QuickBooks", file: "/brands/quickbooks.svg", aspect: 1 },
  // Intuit's QuickBooks lockup: the circle, then "intuit quickbooks" in currentColor, which an image draws in black.
  // Its circle is 227.5 of its 274 high, so it is drawn 274 / 227.5 of `size` tall: the circle at `size`.
  "quickbooks-lockup": { name: "QuickBooks", file: "/brands/quickbooks-lockup.svg", aspect: 955 / 274, scale: 274 / 227.502, wordmark: true },
  hubspot: { name: "HubSpot", file: "/brands/hubspot.svg", aspect: 22 / 26 },
};

/** The files every mark is served from, for the tests that hold them to their owners' originals. */
export const BRAND_FILES: Readonly<Record<Brand, string>> = Object.fromEntries(Object.entries(MARKS).map(([brand, mark]) => [brand, mark.file])) as Record<Brand, string>;

/** True when the mark spells the name itself (npm's, Xero's, QuickBooks' lockup), so the name beside it is for screen readers only. */
export const isWordmark = (brand: Brand) => MARKS[brand].wordmark === true;

/**
 * The mark each connector shows beside its name in Settings and on its connect and launch pages. Pipedrive shows its
 * name alone: no logo of Pipedrive's is used (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P20).
 */
export const PROVIDER_MARKS: Readonly<Record<Exclude<ProviderId, "pipedrive">, Brand>> = { xero: "xero", quickbooks: "quickbooks", hubspot: "hubspot" };

/**
 * A brand's mark, `size` pixels tall. A file that carries clear space around
 * its mark is drawn larger and pulled in by the same amount, so every mark
 * shows at the same height without cutting the owner's file; a mark with a
 * `scale` is drawn that much taller or shorter, in proportion.
 */
export function BrandMark({ brand, size = 16, className }: { brand: Brand; size?: number; className?: string }) {
  const mark = MARKS[brand];
  const height = size * (mark.scale ?? 1);
  const box = height / (1 - 2 * (mark.inset ?? 0));
  const pull = (height - box) / 2;
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

/**
 * A brand's mark with the name it stands beside, for a heading or a label. A
 * wordmark that spells the name (npm's, Xero's, QuickBooks' lockup) shows in its
 * place, the name kept for screen readers; any other mark is decoration before
 * the written name.
 */
export function BrandName({ brand, name, size, className }: { brand: Brand; name: string; size?: number; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <BrandMark brand={brand} size={size} />
      <span className={isWordmark(brand) ? "sr-only" : undefined}>{name}</span>
    </span>
  );
}
