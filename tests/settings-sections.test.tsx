import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { railScrollFor } from "@/components/SettingsContents";
import { SettingsSections, shownGroups, type SettingsGroup } from "@/components/SettingsSections";

/**
 * Settings, grouped, with its contents (Settings structure design S1, S2), as the server renders it. The page hands
 * every section over once, `null` where the viewer does not get it; the groups and both copies of the contents come
 * from that one list.
 */

const section = (id: string, title: string, shown = true) => ({
  id,
  title,
  content: shown ? (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
    </section>
  ) : null,
});

const GROUPS: SettingsGroup[] = [
  { key: "you", label: "You", sections: [section("notifications-title", "Notifications")] },
  { key: "workspace", label: "Workspace", sections: [section("go-live-title", "Go live"), section("usyc-reserve-title", "USYC reserve", false)] },
  { key: "integrations", label: "Integrations", sections: [section("slack-title", "Slack", false)] },
  { key: "danger", label: "Danger zone", sections: [section("delete-workspace-title", "Delete workspace")] },
];

const html = (node: ReactElement) => renderToStaticMarkup(node);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("shownGroups", () => {
  it("leaves out a section with no content, and a group left with none", () => {
    const shown = shownGroups(GROUPS);
    expect(shown.map((group) => group.key)).toEqual(["you", "workspace", "danger"]);
    expect(shown[1].sections.map((s) => s.id)).toEqual(["go-live-title"]);
  });

  it("treats false and undefined content as nothing too", () => {
    const shown = shownGroups([{ key: "g", label: "G", sections: [{ id: "a", title: "A", content: false }, { id: "b", title: "B", content: undefined }] }]);
    expect(shown).toEqual([]);
  });
});

describe("SettingsSections", () => {
  const markup = html(<SettingsSections groups={GROUPS} />);

  it("draws each shown group under its label, in order", () => {
    const labels = [...markup.matchAll(/<p id="settings-group-([a-z]+)"[^>]*>([^<]+)<\/p>/g)].map((m) => [m[1], m[2]]);
    expect(labels).toEqual([
      ["you", "You"],
      ["workspace", "Workspace"],
      ["danger", "Danger zone"],
    ]);
    expect(markup).toContain('role="group" aria-labelledby="settings-group-workspace"');
  });

  it("links every shown section's heading from both copies of the contents, and nothing else", () => {
    const links = [...markup.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    const once = ["notifications-title", "go-live-title", "delete-workspace-title"];
    expect(links).toEqual([...once, ...once]);
    expect(markup.match(/aria-label="Settings sections"/g)).toHaveLength(2);
  });

  it("names no hidden section anywhere", () => {
    expect(text(markup)).not.toContain("USYC reserve");
    expect(text(markup)).not.toContain("Slack");
    expect(text(markup)).not.toContain("Integrations");
  });

  it("renders each shown section once", () => {
    expect(markup.match(/<h2 id="go-live-title"/g)).toHaveLength(1);
  });

  it("marks the first section as the one being read before anything scrolls", () => {
    expect(markup).toMatch(/href="#notifications-title" aria-current="location"/);
    expect(markup.match(/aria-current=/g)).toHaveLength(1);
  });

  it("keeps the rail within the window below the header, scrolling a longer list within it rather than cutting it off", () => {
    const rail = /<div class="([^"]*sticky top-22[^"]*)"/.exec(markup)?.[1] ?? "";
    for (const name of ["max-h-[calc(100dvh-7rem)]", "overflow-y-auto", "overscroll-contain"]) expect(rail.split(" "), name).toContain(name);
  });
});

describe("railScrollFor", () => {
  const rail = { scrollTop: 100, height: 400 };

  it("leaves the rail where it is while the link shows whole", () => {
    expect(railScrollFor(rail, { top: 200, height: 28 })).toBe(100);
  });

  it("scrolls just far enough to show a link below or above, with room to spare", () => {
    expect(railScrollFor(rail, { top: 600, height: 28 })).toBe(600 + 28 + 24 - 400);
    expect(railScrollFor(rail, { top: 110, height: 28 })).toBe(110 - 24);
    expect(railScrollFor(rail, { top: 10, height: 28 })).toBe(0);
  });
});
