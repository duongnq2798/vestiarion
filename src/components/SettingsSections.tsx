import { Fragment, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { SettingsContents, type ContentsGroup } from "./SettingsContents";
import { GROUP_LABEL } from "./settings-group-label";

export interface SettingsSection {
  /** The id of the section's own heading, which the contents link to. */
  id: string;
  /** The heading's words, as the section shows them. */
  title: string;
  /** The section, or nothing where this viewer or this deployment does not get it. */
  content: ReactNode;
}

export interface SettingsGroup {
  key: string;
  label: string;
  sections: SettingsSection[];
}

/** The groups as this viewer gets them: a section with no content is left out, and so is a group left with none. */
export function shownGroups(groups: SettingsGroup[]): SettingsGroup[] {
  return groups
    .map((group) => ({ ...group, sections: group.sections.filter((section) => section.content !== null && section.content !== undefined && section.content !== false) }))
    .filter((group) => group.sections.length > 0);
}

/**
 * Settings, grouped (Settings structure design S1, S2): each group under its label, with a rule between groups, and
 * the contents beside the sections from `xl` or above them below it. The page decides which sections a viewer gets,
 * in one place, so the contents never list a section the page left out.
 */
export function SettingsSections({ groups }: { groups: SettingsGroup[] }) {
  const shown = shownGroups(groups);
  const contents: ContentsGroup[] = shown.map((group) => ({
    key: group.key,
    label: group.label,
    sections: group.sections.map(({ id, title }) => ({ id, title })),
  }));

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_10rem] xl:gap-10">
      <div className="min-w-0">
        <SettingsContents groups={contents} variant="inline" className="mb-10 xl:hidden" />
        {/* A section's heading lands a little below the workspace header, which the page's scroll padding already clears. */}
        <div className="space-y-10 [&_h2]:scroll-mt-6 [&_section]:scroll-mt-6">
          {shown.map((group, index) => (
            <div key={group.key} role="group" aria-labelledby={`settings-group-${group.key}`} className={cn(index > 0 && "border-t border-line pt-10")}>
              <p id={`settings-group-${group.key}`} className={GROUP_LABEL}>
                {group.label}
              </p>
              <div className="mt-4 space-y-10">
                {group.sections.map((section) => (
                  <Fragment key={section.id}>{section.content}</Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <SettingsContents groups={contents} variant="rail" className="hidden xl:block" />
    </div>
  );
}
