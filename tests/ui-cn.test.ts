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

  it("knows the elevations are one property", () => {
    expect(cn("shadow-surface", "shadow-overlay")).toBe("shadow-overlay");
  });

  it("knows the easing and animation tokens", () => {
    expect(cn("ease-standard", "ease-exit")).toBe("ease-exit");
    expect(cn("animate-arrive", "animate-shimmer")).toBe("animate-shimmer");
  });

  it("leaves the brand textures alone", () => {
    expect(cn("hatch", "border-dashed", "ledger-grid")).toBe("hatch border-dashed ledger-grid");
  });
});
