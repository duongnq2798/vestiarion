import { describe, expect, it } from "vitest";
import { resolveSiteOrigin } from "@/lib/auth/env";

describe("resolveSiteOrigin — the origin sign-in links are built from", () => {
  it("keeps a bare origin", () => {
    expect(resolveSiteOrigin("https://vestiarion.vercel.app", "production")).toBe(
      "https://vestiarion.vercel.app",
    );
  });

  it("drops a trailing path", () => {
    expect(resolveSiteOrigin("https://vestiarion.vercel.app/some/path/", "production")).toBe(
      "https://vestiarion.vercel.app",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveSiteOrigin(" http://localhost:3001 ", "development")).toBe("http://localhost:3001");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => resolveSiteOrigin("javascript:alert(1)", "production")).toThrow(/SITE_URL/);
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() => resolveSiteOrigin("not a url", "production")).toThrow(/SITE_URL/);
  });

  it("requires SITE_URL in production when undefined", () => {
    expect(() => resolveSiteOrigin(undefined, "production")).toThrow(/SITE_URL/);
  });

  it("requires SITE_URL in production when blank", () => {
    expect(() => resolveSiteOrigin("", "production")).toThrow(/SITE_URL/);
  });

  it("defaults to localhost:3000 outside production when undefined", () => {
    expect(resolveSiteOrigin(undefined, "development")).toBe("http://localhost:3000");
  });

  it("defaults to localhost:3000 when NODE_ENV itself is undefined", () => {
    expect(resolveSiteOrigin(undefined, undefined)).toBe("http://localhost:3000");
  });
});
