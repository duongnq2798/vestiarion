/**
 * Where a close pack's time goes (docs/superpowers/specs/2026-10-26-close-pack-page-speed-design.md CS7): one log line
 * per page render and one per read, `close_pack_timing` and a JSON object of whole milliseconds per stage, with counts.
 * It names no workspace, person, record or month: the request the line is logged under says which page it was.
 */
export function logClosePackTiming(stage: "page" | "read", fields: Record<string, number | boolean>): void {
  const line: Record<string, string | number | boolean> = { stage };
  for (const [name, value] of Object.entries(fields)) line[name] = typeof value === "number" ? Math.round(value) : value;
  console.info("close_pack_timing", JSON.stringify(line));
}

/** Milliseconds since `start`, a `performance.now()` reading. */
export const msSince = (start: number): number => performance.now() - start;
