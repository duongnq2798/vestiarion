import { describe, expect, it } from "vitest";
import { cn } from "@/components/ui/cn";

describe("cn", () => {
  it("lets the later of two conflicting classes win", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });

  it("drops falsy inputs", () => {
    expect(cn("bg-agent", false, undefined, null, "text-on-agent")).toBe("bg-agent text-on-agent");
  });

  it("keeps the reasoning font size beside a text colour", () => {
    expect(cn("text-reasoning", "text-ink")).toBe("text-reasoning text-ink");
  });

  it("treats the reasoning size as a font size", () => {
    expect(cn("text-sm", "text-reasoning")).toBe("text-reasoning");
  });

  it.each(["eyebrow", "caption", "ui", "body", "lede", "positioning", "section", "display"])("keeps the %s size beside a text colour and allows size overrides", (size) => {
    expect(cn(`text-${size}`, "text-ink")).toBe(`text-${size} text-ink`);
    expect(cn("text-sm", `text-${size}`)).toBe(`text-${size}`);
    expect(cn(`text-${size}`, "text-sm")).toBe("text-sm");
  });

  it("lets the caller flatten a card without losing its text size", () => {
    expect(cn("shadow-surface text-body text-ink", "shadow-flat")).toBe("text-body text-ink shadow-flat");
  });

  it("lets callers override public section spacing", () => {
    expect(cn("px-page py-section", "px-8 py-12")).toBe("px-8 py-12");
    expect(cn("px-8 py-12", "px-page py-section")).toBe("px-page py-section");
  });

  it("knows the elevations are one property", () => {
    expect(cn("shadow-surface", "shadow-overlay")).toBe("shadow-overlay");
  });

  it("knows the easing and animation tokens", () => {
    expect(cn("ease-standard", "ease-exit")).toBe("ease-exit");
    expect(cn("animate-arrive", "animate-shimmer")).toBe("animate-shimmer");
  });

  it("lets callers override semantic interaction durations", () => {
    expect(cn("duration-micro", "duration-300")).toBe("duration-300");
    expect(cn("duration-300", "duration-overlay")).toBe("duration-overlay");
  });

  it("replaces the inherited focus palette when a nested surface changes", () => {
    expect(cn("focus-inverse", "focus-default")).toBe("focus-default");
    expect(cn("focus-default", "focus-inverse")).toBe("focus-inverse");
  });

  it("leaves the brand textures alone", () => {
    expect(cn("hatch", "border-dashed", "ledger-grid")).toBe("hatch border-dashed ledger-grid");
  });
});
