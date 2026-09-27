import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The Data Access Layer is the only code that may hold the service-role
    // client (spec §5.6, Line 1). Everything else goes through db(), which
    // cannot forget an organization.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/dal/**", "src/lib/context.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@supabase/supabase-js",
            importNames: ["createClient"],
            allowTypeImports: true,
            message: "Use db() or platformDb() from @/lib/dal; the raw client can read every organization.",
          },
          {
            name: "@/lib/context",
            importNames: ["currentContext", "createContext"],
            message: "The context's client bypasses organization scoping. Use db() or platformDb() from @/lib/dal.",
          },
        ],
        patterns: [
          {
            group: ["**/context"],
            importNames: ["currentContext", "createContext"],
            message: "The context's client bypasses organization scoping. Use db() or platformDb() from @/lib/dal.",
          },
        ],
      }],
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
