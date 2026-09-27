import { describe, expect, it } from "vitest";
import { orgSlugFromArgv } from "../scripts/lib/org-arg";

describe("orgSlugFromArgv", () => {
  it("takes the first positional argument", () => {
    expect(orgSlugFromArgv(["founding"], "npm run cycle -- <org-slug>")).toBe("founding");
  });

  it("ignores flags", () => {
    expect(orgSlugFromArgv(["--verbose", "northstar"], "u")).toBe("northstar");
  });

  it("refuses to run without one, naming the usage", () => {
    expect(() => orgSlugFromArgv([], "npm run cycle -- <org-slug>")).toThrow("Usage: npm run cycle -- <org-slug>");
  });

  it("refuses a slug that could not exist", () => {
    expect(() => orgSlugFromArgv(["Not A Slug"], "u")).toThrow(/not a valid organization slug/);
  });
});
