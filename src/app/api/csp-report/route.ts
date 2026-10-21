import { cspViolations } from "@/lib/security/csp";
import { takeCspReportToken } from "@/lib/rate-limit";

/** A report is a few hundred bytes; the Reporting API batches a handful. Anything larger is not a report. */
const MAX_BODY_BYTES = 64 * 1024;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Where browsers send what the report-only Content Security Policy would have blocked
 * (docs/superpowers/specs/2026-10-21-csp-report-only-design.md CSP4). Each violation is one line in the server log:
 * the directive, the blocked origin or keyword, and the page's first path segment. Nothing else from the report is kept,
 * not its full addresses, sample, referrer or the client's address, and nothing is stored. Browsers send reports
 * without cookies, from any page of this site, so it needs no session.
 */
export async function POST(request: Request): Promise<Response> {
  if (!takeCspReportToken(clientIp(request))) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  for (const violation of cspViolations(body)) console.warn("csp report-only", JSON.stringify(violation));
  return new Response(null, { status: 204 });
}
