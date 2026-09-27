import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The spec's build-time proof (§9): code outside the Data Access Layer cannot
 * reach the service-role client, so it cannot read another organization's rows
 * by forgetting a filter.
 */

const FIXTURES: Record<string, string> = {
  "reaches for the context's client": 'import { currentContext } from "@/lib/context";\nexport const leak = () => currentContext().db;\n',
  "builds its own client": 'import { createClient } from "@supabase/supabase-js";\nexport const leak = () => createClient("u", "k");\n',
  "reaches for the context relatively": 'import { createContext } from "../../lib/context";\nexport const leak = createContext;\n',
};

async function restrictedImportMessages(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports").map((message) => message.message);
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
});
