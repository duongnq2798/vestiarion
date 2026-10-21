import { cspViolations } from "@/lib/security/csp";
import { takeCspReportToken } from "@/lib/rate-limit";

/** A report is a few hundred bytes; the Reporting API batches a handful. Anything larger is not a report. */
export const MAX_REPORT_BYTES = 64 * 1024;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/** The body as text, read no further than `limit` bytes: `too_large` past it, `failed` when the client stops sending. */
async function readCapped(request: Request, limit: number): Promise<{ text: string } | "too_large" | "failed"> {
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "failed";
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

/**
 * Where browsers send what the report-only Content Security Policy would have blocked
 * (docs/superpowers/specs/2026-10-21-csp-report-only-design.md CSP4). Each violation is one line in the server log:
 * the directive, the blocked origin or keyword, and the page's first path segment. Nothing else from the report is kept,
 * not its full addresses, sample, referrer or the client's address, and nothing is stored. Browsers send reports
 * without cookies, from any page of this site, so it needs no session.
 *
 * Past the rate limit a report is dropped and still answered 204: browsers send a refused report again, several times.
 */
export async function POST(request: Request): Promise<Response> {
  if (!takeCspReportToken(clientIp(request))) return new Response(null, { status: 204 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
  const read = await readCapped(request, MAX_REPORT_BYTES);
  if (read === "too_large") return new Response(null, { status: 413 });
  if (read === "failed") return new Response(null, { status: 400 });
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return new Response(null, { status: 400 });
  }
  for (const violation of cspViolations(body)) console.warn("csp report-only", JSON.stringify(violation));
  return new Response(null, { status: 204 });
}
