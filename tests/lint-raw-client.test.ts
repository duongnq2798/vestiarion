import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The spec's build-time proof (§9): code outside the Data Access Layer cannot
 * reach the service-role client, so it cannot read another organization's rows
 * by forgetting a filter. Covers both ways in: a static import (of
 * `createClient`, `SupabaseClient`, or the context) and a dynamic `import()`,
 * which is invisible to `no-restricted-imports` and so needs its own rule,
 * `no-restricted-syntax`, checked here alongside it (R16).
 */

const FIXTURES: Record<string, string> = {
  "reaches for the context's client": 'import { currentContext } from "@/lib/context";\nexport const leak = () => currentContext().db;\n',
  "builds its own client": 'import { createClient } from "@supabase/supabase-js";\nexport const leak = () => createClient("u", "k");\n',
  "reaches for the context relatively": 'import { createContext } from "../../lib/context";\nexport const leak = createContext;\n',
  "builds its own client via `new SupabaseClient`": 'import { SupabaseClient } from "@supabase/supabase-js";\nexport const leak = () => new SupabaseClient("u", "k");\n',
  "dynamically imports the raw client": 'export const leak = async () => await import("@supabase/supabase-js");\n',
  "dynamically imports the context": 'export const leak = async () => await import("@/lib/context");\n',
  "dynamically imports the context relatively": 'export const leak = async () => await import("../../lib/context");\n',
  // runWith and runWithConfig accept `{ orgId }` beside any configuration, so
  // a scope entered with them could read one organization's rows while
  // signing and paying with the environment's secrets. Organizations are
  // entered through @/lib/dal/scope instead (R19).
  "enters an organization's scope by hand": 'import { runWithConfig } from "@/lib/context";\nexport const enter = runWithConfig;\n',
  "enters a scope by hand, relatively": 'import { runWith } from "../../lib/context";\nexport const enter = runWith;\n',
};

async function restrictedImportMessages(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

describe("the raw database client", () => {
  it.each(Object.entries(FIXTURES))("is refused in application code that %s", async (_label, code) => {
    expect(await restrictedImportMessages(code, "src/app/fixture-raw-client.ts")).not.toEqual([]);
  }, 60_000);

  it.each(Object.entries(FIXTURES))("is allowed inside the DAL for code that %s", async (_label, code) => {
    expect(await restrictedImportMessages(code, "src/lib/dal/fixture-raw-client.ts")).toEqual([]);
  }, 60_000);

  it("leaves type-only imports alone", async () => {
    const code = 'import type { SupabaseClient } from "@supabase/supabase-js";\nexport type Client = SupabaseClient;\n';
    expect(await restrictedImportMessages(code, "src/app/fixture-types.ts")).toEqual([]);
  }, 60_000);

  it("leaves an inline `type` specifier alone", async () => {
    const code = 'import { type SupabaseClient } from "@supabase/supabase-js";\nexport type Client = SupabaseClient;\n';
    expect(await restrictedImportMessages(code, "src/app/fixture-types.ts")).toEqual([]);
  }, 60_000);
});
