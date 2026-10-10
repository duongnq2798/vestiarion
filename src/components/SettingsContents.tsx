"use client";

import { useId } from "react";
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

/**
 * The contents of Settings (Settings structure design S2). `rail`: a column that stays beside the sections from `xl`,
 * marking the one being read. `inline`: a list above the sections on a narrower screen, each group on its own row,
 * its label beside its links.
 * The links are plain anchors; the page scrolls itself.
 */
export function SettingsContents({ groups, variant, className }: { groups: ContentsGroup[]; variant: "rail" | "inline"; className?: string }) {
  const id = useId();
  // Only the rail marks a section; the list above the sections has scrolled away by the time one is read.
  const active = useActiveHeading(variant === "rail" ? groups.flatMap((group) => group.sections.map((section) => section.id)) : [], READING_LINE);

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
      <div className="sticky top-22 space-y-5">
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
