"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/components/ui/cn";
import { useActiveHeading } from "@/components/ui/useActiveHeading";
import { GROUP_LABEL } from "./settings-group-label";

/** A group of Settings, as its contents list it: the group's label, and each section's title and heading id. */
export interface ContentsGroup {
  key: string;
  label: string;
  sections: { id: string; title: string }[];
}

/** How far below the top of the window a section's heading counts as the one being read: below the workspace header, which sticks at every width (workspace shell design S4), and below where a jump to a heading lands. */
const READING_LINE = 128;

/** Room above and below a link the rail scrolls to, so the one being read never sits flush against the rail's edge. */
const RAIL_MARGIN = 24;

/**
 * Where a rail that scrolls itself should scroll to show a link whole: unchanged when the link already shows, else just
 * far enough, with `margin` to spare. Positions are within the rail's content, as `scrollTop` measures them.
 */
export function railScrollFor(rail: { scrollTop: number; height: number }, link: { top: number; height: number }, margin = RAIL_MARGIN): number {
  if (link.top - margin < rail.scrollTop) return Math.max(0, link.top - margin);
  if (link.top + link.height + margin > rail.scrollTop + rail.height) return link.top + link.height + margin - rail.height;
  return rail.scrollTop;
}

/**
 * The contents of Settings (Settings structure design S2). `rail`: a column that stays beside the sections from `xl`,
 * marking the one being read. It is never taller than the window below the workspace header: a longer list scrolls
 * within it, and follows the section being read. `inline`: a list above the sections on a narrower screen, each group
 * on its own row, its label beside its links.
 * The links are plain anchors; the page scrolls itself.
 */
export function SettingsContents({ groups, variant, className }: { groups: ContentsGroup[]; variant: "rail" | "inline"; className?: string }) {
  const id = useId();
  // Only the rail marks a section; the list above the sections has scrolled away by the time one is read.
  const active = useActiveHeading(variant === "rail" ? groups.flatMap((group) => group.sections.map((section) => section.id)) : [], READING_LINE);
  const rail = useRef<HTMLDivElement>(null);

  // The rail scrolls only itself to the section being read, never the page.
  useEffect(() => {
    const box = rail.current;
    const link = box?.querySelector<HTMLElement>('a[aria-current="location"]');
    if (!box || !link || box.scrollHeight <= box.clientHeight) return;
    const top = link.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const next = railScrollFor({ scrollTop: box.scrollTop, height: box.clientHeight }, { top, height: link.offsetHeight });
    if (next !== box.scrollTop) box.scrollTop = next;
  }, [active]);

  if (variant === "inline") {
    return (
      <nav aria-label="Settings sections" className={cn("rounded-2xl border border-line bg-surface/60 px-4 py-3 sm:px-5", className)}>
        <ul className="space-y-0.5">
          {groups.map((group, index) => (
            <li key={group.key} className="flex items-baseline gap-3 sm:gap-4">
              <span id={`${id}-${index}`} className={cn(GROUP_LABEL, "w-28 shrink-0")}>
                {group.label}
              </span>
              <ul aria-labelledby={`${id}-${index}`} className="flex min-w-0 flex-wrap gap-x-4">
                {group.sections.map((section) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      className="inline-block py-1 text-[0.8125rem] text-ink-2 underline-offset-4 transition-colors duration-150 ease-standard hover:text-ink hover:underline"
                    >
                      {section.title}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="Settings sections" className={className}>
      {/* Never taller than the window below the workspace header (top-22), so its last groups can always be reached; the
          padding keeps a link's focus ring inside the scrolling box, and the negative margin keeps the column aligned. */}
      <div ref={rail} className="sticky top-22 -mx-1.5 -mt-1.5 max-h-[calc(100dvh-7rem)] space-y-5 overflow-y-auto overscroll-contain px-1.5 py-1.5 [scrollbar-width:thin]">
        {groups.map((group, index) => (
          <div key={group.key}>
            <p id={`${id}-${index}`} className={GROUP_LABEL}>
              {group.label}
            </p>
            <ul aria-labelledby={`${id}-${index}`} className="mt-1.5 space-y-0.5 border-l border-line">
              {group.sections.map((section) => {
                const current = section.id === active;
                return (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      aria-current={current ? "location" : undefined}
                      className={cn(
                        "-ml-px block border-l py-1 pl-3 text-[0.8125rem] leading-snug transition-colors duration-150 ease-standard",
                        current ? "border-agent font-medium text-agent" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink"
                      )}
                    >
                      {section.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
