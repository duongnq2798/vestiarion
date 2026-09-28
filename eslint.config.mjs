import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Shared by both the static-import rule and the dynamic-import rule below, so
// the two forms of the same warning cannot drift apart (R16).
const RAW_CLIENT_MESSAGE = "Use db() or platformDb() from @/lib/dal; the raw client can read every organization.";
const CONTEXT_MESSAGE =
  "The context's client, runWith and runWithConfig bypass organization scoping. Use db() or platformDb() from " +
  "@/lib/dal, and enter an organization through @/lib/dal/scope.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The Data Access Layer is the only code that may hold the service-role
    // client (spec §5.6, Line 1). Everything else goes through db(), which
    // cannot forget an organization.
    //
    // Two rules, because neither alone sees every way in. `no-restricted-imports`
    // never visits `import()` — ESLint registers no ImportExpression handler for
    // it — so a dynamic import of the same specifiers is invisible to it; that
    // is what `no-restricted-syntax` below is for. And `new SupabaseClient(...)`
    // is exactly what `createClient` wraps, so it is restricted by name here too
    // (R16); `allowTypeImports` keeps `import type { SupabaseClient }` and
    // `import { type SupabaseClient }` allowed, since both files below only ever
    // use it as a type.
    //
    // `runWith` and `runWithConfig` are restricted with the context's client:
    // they accept `{ orgId }` beside any configuration, so a scope entered with
    // them could read one organization's rows while signing and paying with
    // the environment's secrets. Organizations are entered through
    // @/lib/dal/scope, which builds the scope from the organization's own row
    // (R19).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/dal/**", "src/lib/context.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@supabase/supabase-js",
            importNames: ["createClient", "SupabaseClient"],
            allowTypeImports: true,
            message: RAW_CLIENT_MESSAGE,
          },
          {
            name: "@/lib/context",
            importNames: ["currentContext", "createContext", "runWith", "runWithConfig"],
            message: CONTEXT_MESSAGE,
          },
        ],
        patterns: [
          {
            group: ["**/context"],
            importNames: ["currentContext", "createContext", "runWith", "runWithConfig"],
            message: CONTEXT_MESSAGE,
          },
        ],
      }],
      // Core rule, not a Next or TypeScript-ESLint one: confirmed (by loading
      // eslint-config-next/core-web-vitals and /typescript and scanning every
      // config object either spreads in) that nothing already sets
      // no-restricted-syntax for these files, so there is nothing to merge
      // into here.
      "no-restricted-syntax": ["error",
        {
          selector: "ImportExpression[source.value='@supabase/supabase-js']",
          message: RAW_CLIENT_MESSAGE,
        },
        {
          // Matches "@/lib/context" and any relative specifier ending in
          // "/context" (e.g. "../../lib/context") — the same reach as the
          // "**/context" pattern above, for the dynamic-import form.
          selector: "ImportExpression[source.value=/(^|\\/)context$/]",
          message: CONTEXT_MESSAGE,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
