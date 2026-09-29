import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/vx/nav";
import { NAV_ICONS } from "@/components/vx/nav-icons";

describe("section icons", () => {
  it("draws an icon for every section — Members once rendered an empty square", () => {
    for (const item of NAV_ITEMS) expect(NAV_ICONS[item.key], item.key).toBeDefined();
  });

  it("draws a different icon for each section", () => {
    const icons = NAV_ITEMS.map((item) => NAV_ICONS[item.key]);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
