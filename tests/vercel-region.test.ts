import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The server runs in Vercel's Tokyo region, beside the Supabase project in ap-northeast-1 (ARCHITECTURE.md, "Where it
 * runs"; spec 2026-10-20-functions-beside-database-design.md). A page or an action makes its database calls one after
 * another, and from Washington (iad1, Vercel's default) each one crossed the Pacific.
 */
describe("vercel.json", () => {
  it("runs the functions in hnd1, beside the database", () => {
    const config = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as { regions?: unknown };
    expect(config.regions).toEqual(["hnd1"]);
  });
});
