/**
 * The app's Content Security Policy, sent report-only (docs/superpowers/specs/2026-10-21-csp-report-only-design.md
 * CSP1-CSP3): browsers report what it would block and block nothing, until the reports show it fits every page and it
 * is enforced. `next.config.ts` sends it on every response; `/api/csp-report` receives the reports.
 *
 * Kept free of other app modules, since `next.config.ts` imports it. `tests/csp.test.ts` holds each origin here to the
 * code that reaches it: the connect forms' OAuth hosts, Circle's Iris and the modular wallets client.
 */

/** Where browsers send reports, by `report-uri` and through the Reporting API's `csp` endpoint. */
export const CSP_REPORT_PATH = "/api/csp-report";
/** The Reporting API's endpoint, named `csp` for the policy's `report-to`. */
export const CSP_REPORTING_ENDPOINTS = `csp="${CSP_REPORT_PATH}"`;

/** Google Analytics 4, as Google lists it for a policy: the tag from Tag Manager, hits to Analytics. */
const GOOGLE_ANALYTICS = {
  script: ["https://*.googletagmanager.com"],
  img: ["https://*.google-analytics.com", "https://*.googletagmanager.com"],
  connect: ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"],
};

/**
 * What the browser itself calls: Circle's Iris for a transfer from another chain (fees and arrival, both networks), and
 * Circle's modular wallets client for a passkey wallet.
 */
const CIRCLE_CONNECT = ["https://iris-api.circle.com", "https://iris-api-sandbox.circle.com", "https://modular-sdk.circle.com"];

/**
 * Where a form's submission may end up. The connect pages post to this deployment, which sends the person on to the
 * tool's consent screen (HubSpot, Asana, Pipedrive, Zoho CRM). Continue with Google is a Server Action that sends them
 * to Supabase Auth, then Google; a browser that submits it before the page's script runs follows those redirects as a
 * form submission.
 */
const FORM_TARGETS = ["https://app.hubspot.com", "https://app.asana.com", "https://oauth.pipedrive.com", "https://accounts.zoho.com", "https://accounts.google.com"];

export interface CspEnv {
  NODE_ENV?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL?: string;
  NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL?: string;
}

/** An `https:` URL's origin, or none: a deployment's setting adds its own origin, never a path, a wildcard or a keyword. */
function httpsOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))];

/**
 * The policy as one header value. Scripts and styles may be inline: Next.js inlines its own, and a nonce would make every
 * page render per request. Development also allows `eval`, which React uses there for its error overlay.
 */
export function contentSecurityPolicy(env: CspEnv = process.env): string {
  const dev = env.NODE_ENV === "development";
  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...GOOGLE_ANALYTICS.script]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", ...GOOGLE_ANALYTICS.img]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'"]],
    [
      "connect-src",
      unique([
        "'self'",
        ...GOOGLE_ANALYTICS.connect,
        ...CIRCLE_CONNECT,
        httpsOrigin(env.NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL),
        httpsOrigin(env.NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL),
      ]),
    ],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", unique(["'self'", ...FORM_TARGETS, httpsOrigin(env.NEXT_PUBLIC_SUPABASE_URL)])],
    ["frame-ancestors", ["'none'"]],
    ["report-uri", [CSP_REPORT_PATH]],
    ["report-to", ["csp"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/** One violation, as the report route logs it: nothing that could carry a token, an address or what someone typed. */
export interface CspViolation {
  /** The directive that would have blocked it, such as `script-src-elem`. */
  directive: string;
  /** The origin it would have blocked, or the browser's keyword for what was not a URL (`inline`, `eval`, `data`). */
  blocked: string;
  /** The page's first path segment only (`/o`, `/p`, `/docs`): a payee link's or a workspace's rest stays out. */
  page: string;
}

const DIRECTIVE = /^[a-z-]{1,40}$/;
const KEYWORD = /^[a-z-]{1,24}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,40}$/;
/** A browser extension's own scripts and frames: reported by some browsers, about the extension, not this app. */
const EXTENSION_SCHEMES = new Set(["chrome-extension:", "moz-extension:", "safari-extension:", "safari-web-extension:"]);

/** What was blocked, as an origin or a keyword; null for what an extension did, which is not this app's to fix. */
function blockedOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "unknown";
  if (KEYWORD.test(value)) return value;
  try {
    const url = new URL(value);
    if (EXTENSION_SCHEMES.has(url.protocol)) return null;
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "ws:") return url.origin;
    return url.protocol.replace(/:$/, "");
  } catch {
    return "unknown";
  }
}

function pageOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  try {
    const segment = new URL(value).pathname.split("/")[1] ?? "";
    if (segment === "") return "/";
    return SEGMENT.test(segment) ? `/${segment}` : "unknown";
  } catch {
    return "unknown";
  }
}

function violationOf(fields: { directive: unknown; blocked: unknown; page: unknown }): CspViolation | null {
  const blocked = blockedOf(fields.blocked);
  if (blocked === null) return null;
  const directive = typeof fields.directive === "string" ? fields.directive.trim().split(/\s+/)[0] ?? "" : "";
  return { directive: DIRECTIVE.test(directive) ? directive : "unknown", blocked, page: pageOf(fields.page) };
}

/** At most this many violations are read from one request: the Reporting API sends them in batches. */
export const CSP_REPORTS_PER_REQUEST = 20;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The violations in a report request, from either format browsers send: `report-uri`'s `{"csp-report": {...}}` or the
 * Reporting API's array of `csp-violation` reports. Anything else reads as none; what each keeps is `CspViolation`.
 */
export function cspViolations(body: unknown): CspViolation[] {
  const reports: CspViolation[] = [];
  const legacy = record(record(body)?.["csp-report"]);
  if (legacy) {
    const violation = violationOf({
      directive: legacy["effective-directive"] ?? legacy["violated-directive"],
      blocked: legacy["blocked-uri"],
      page: legacy["document-uri"],
    });
    if (violation) reports.push(violation);
    return reports;
  }
  if (!Array.isArray(body)) return reports;
  for (const entry of body.slice(0, CSP_REPORTS_PER_REQUEST)) {
    const report = record(entry);
    const fields = record(report?.body);
    if (report?.type !== "csp-violation" || !fields) continue;
    const violation = violationOf({ directive: fields.effectiveDirective, blocked: fields.blockedURL, page: fields.documentURL ?? report.url });
    if (violation) reports.push(violation);
  }
  return reports;
}
