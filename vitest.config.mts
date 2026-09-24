import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run in the `node` environment, not jsdom: everything under test is
 * server-side treasury logic — hash chains, risk tiering, guardrails — and
 * none of it touches the DOM. React components are covered by the app
 * itself; the money paths are covered here.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/supabase.ts"],
    },
  },
});
