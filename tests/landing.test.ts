import { describe, expect, it } from "vitest";
import { median } from "@/lib/landing";

describe("landing metric helpers", () => {
  it("returns no median when no measurement exists", () => {
    expect(median([])).toBeNull();
  });

  it("computes odd and even medians without changing the source order", () => {
    const values = [9, 1, 5, 3];
    expect(median(values)).toBe(4);
    expect(values).toEqual([9, 1, 5, 3]);
    expect(median([9, 2, 4])).toBe(4);
  });
});
