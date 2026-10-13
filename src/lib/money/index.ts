/**
 * The canonical money representation (docs/superpowers/specs/2026-10-13-currency-provenance-design.md): amounts in
 * minor units, rates that say their kind, figures with their provenance, totals in a reporting currency and the FX
 * variance on a paid bill. Browser-safe and pure; the reads and writes are `src/lib/fx/rates-store.ts` and its peers.
 */
export * from "./money";
export * from "./rate";
export * from "./reporting";
export * from "./provenance";
export * from "./variance";
