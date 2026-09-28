import { describe, expect, it } from "vitest";
import { plural } from "@/lib/copy";

describe("plural", () => {
  it("returns the one-form at a count of exactly 1", () => {
    expect(plural(1, "1 decision logged", "2 decisions logged")).toBe("1 decision logged");
  });

  it("returns the many-form for zero and for anything above 1", () => {
    expect(plural(0, "1 decision logged", "0 decisions logged")).toBe("0 decisions logged");
    expect(plural(2, "1 decision logged", "2 decisions logged")).toBe("2 decisions logged");
  });
});
