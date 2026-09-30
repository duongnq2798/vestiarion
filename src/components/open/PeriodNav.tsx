import Link from "next/link";
import { cn } from "@/components/ui/cn";
import type { Period } from "@/lib/platform/open-numbers";

const LINKS: ReadonlyArray<{ key: Period["key"]; href: string; label: string }> = [
  { key: "all", href: "/open", label: "All time" },
  { key: "7d", href: "/open?period=7d", label: "Last 7 days" },
  { key: "30d", href: "/open?period=30d", label: "Last 30 days" },
];

const CHIP = "inline-flex h-8 items-center rounded-full border px-3 font-mono text-xs font-semibold transition-colors duration-150 ease-standard";

/** The period switch: fixed ranges as links, plus the dated period when the query names one. */
export function PeriodNav({ period }: { period: Period }) {
  return (
    <nav aria-label="Period" className="flex flex-wrap items-center gap-2">
      {LINKS.map((link) => {
        const current = link.key === period.key;
        return (
          <Link
            key={link.key}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(CHIP, current ? "border-ink bg-ink text-surface" : "border-line-strong bg-surface text-ink-2 hover:text-ink")}
          >
            {link.label}
          </Link>
        );
      })}
      {period.key === "since" && (
        <Link href={`/open${period.query}`} aria-current="page" className={cn(CHIP, "border-ink bg-ink text-surface")}>
          {period.label}
        </Link>
      )}
    </nav>
  );
}
