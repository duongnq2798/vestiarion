import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { MAX_REPORT_BYTES, POST } from "@/app/api/csp-report/route";
import { ASANA_AUTHORIZE } from "@/lib/asana/http";
import { HUBSPOT_AUTHORIZE } from "@/lib/hubspot/http";
import { NETWORKS } from "@/lib/network";
import { PIPEDRIVE_AUTHORIZE } from "@/lib/pipedrive/http";
import { INTUIT_AUTHORIZE } from "@/lib/quickbooks/http";
import { takeCspReportToken } from "@/lib/rate-limit";
import { PRODUCT_HUNT_BADGE } from "@/lib/site-links";
import { contentSecurityPolicy, CSP_REPORT_PATH, CSP_REPORTING_ENDPOINTS, CSP_REPORTS_PER_REQUEST, cspHeaders, cspViolations, REPORT_ONLY_DIRECTIVES } from "@/lib/security/csp";
import { XERO_AUTHORIZE } from "@/lib/xero/http";
import { ZOHO_REGIONS } from "@/lib/zohobooks/regions";

/**
 * The report-only Content Security Policy (docs/superpowers/specs/2026-10-21-csp-report-only-design.md CSP1-CSP4): the
 * policy, every origin in it held to the code that reaches it, the header on every response, and the report route,
 * which keeps only a directive, an origin and a page's first segment.
 */

const directives = (policy: string) =>
  new Map(policy.split("; ").map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1)] as const));

describe("the policy (CSP1, CSP2)", () => {
  const policy = directives(contentSecurityPolicy({ NODE_ENV: "production" }));

  it("allows this site, inline scripts and styles, and Google Analytics, and nothing framing it", () => {
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toEqual(["'self'", "'unsafe-inline'", "https://*.googletagmanager.com"]);
    expect(policy.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("report-uri")).toEqual([CSP_REPORT_PATH]);
    expect(policy.get("report-to")).toEqual(["csp"]);
    expect(CSP_REPORTING_ENDPOINTS).toBe(`csp="${CSP_REPORT_PATH}"`);
  });

  it("lets the site footer show Product Hunt's badge, which Product Hunt draws", () => {
    expect(policy.get("img-src")).toContain(new URL(PRODUCT_HUNT_BADGE.src).origin);
    expect(policy.get("img-src")).toContain("https://api.producthunt.com");
  });

  it("allows eval in development only, where React uses it", () => {
    expect(directives(contentSecurityPolicy({ NODE_ENV: "development" })).get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
  });

  it("allows Vercel's toolbar on a preview deployment only", () => {
    const preview = directives(contentSecurityPolicy({ NODE_ENV: "production", VERCEL_ENV: "preview" }));
    for (const directive of ["script-src", "connect-src", "frame-src"]) expect(preview.get(directive), directive).toContain("https://vercel.live");
    const production = directives(contentSecurityPolicy({ NODE_ENV: "production", VERCEL_ENV: "production" }));
    expect([...production.values()].flat().join(" ")).not.toContain("vercel");
    expect(production.has("frame-src")).toBe(false);
  });

  it("lets the tag Google Analytics loads come from the origins it allows", () => {
    const tag = /src=\{`(https:\/\/[^/`]+)\//.exec(readFileSync("src/components/analytics/GoogleAnalytics.tsx", "utf8"))?.[1];
    expect(tag).toBe("https://www.googletagmanager.com");
    const allowed = (origin: string, sources: readonly string[]) =>
      sources.some((source) => source === origin || (source.startsWith("https://*.") && origin.endsWith(source.slice("https://*".length))));
    expect(allowed(tag!, policy.get("script-src")!)).toBe(true);
    expect(allowed(tag!, policy.get("connect-src")!)).toBe(true);
  });

  it("lets the browser reach Circle's Iris on both networks and the modular wallets client", async () => {
    for (const profile of Object.values(NETWORKS)) {
      if (profile.inbound) expect(policy.get("connect-src"), profile.id).toContain(new URL(profile.inbound.iris).origin);
    }
    const { readFileSync } = await import("node:fs");
    const treasury = readFileSync("src/lib/passkey-treasury.ts", "utf8");
    const defaultClient = /const CIRCLE_CLIENT_URL = "([^"]+)"/.exec(treasury)?.[1];
    expect(defaultClient).toBeTruthy();
    expect(policy.get("connect-src")).toContain(new URL(defaultClient!).origin);
  });

  it("adds a deployment's own modular wallets client and Supabase origins, never a path or a non-https value", () => {
    const own = directives(
      contentSecurityPolicy({
        NODE_ENV: "production",
        NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL: "https://wallets.example.test/v1/rpc/w3s/abc",
        NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL: "http://insecure.example.test",
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co/",
      })
    );
    expect(own.get("connect-src")).toContain("https://wallets.example.test");
    expect(own.get("connect-src")!.join(" ")).not.toContain("insecure");
    expect(own.get("connect-src")!.join(" ")).not.toContain("/v1/");
    expect(own.get("form-action")).toContain("https://project.supabase.co");
    expect(directives(contentSecurityPolicy({ NEXT_PUBLIC_SUPABASE_URL: "not a url; script-src *" })).get("form-action")!.join(" ")).not.toContain("*");
  });

  it("lets every connect form end at its tool's consent screen, every Zoho data center's, and Continue with Google at Google", () => {
    // Each connect route's tool, and where its consent screen is: a new connect route fails here until it is named.
    const consent: Record<string, string[]> = {
      asana: [ASANA_AUTHORIZE],
      hubspot: [HUBSPOT_AUTHORIZE],
      pipedrive: [PIPEDRIVE_AUTHORIZE],
      quickbooks: [INTUIT_AUTHORIZE],
      xero: [XERO_AUTHORIZE],
      zohobooks: Object.values(ZOHO_REGIONS).map((region) => region.accounts),
      zohocrm: Object.values(ZOHO_REGIONS).map((region) => region.accounts),
    };
    const routes = readdirSync("src/app/api/integrations", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && readdirSync(`src/app/api/integrations/${entry.name}`).includes("connect"))
      .map((entry) => entry.name)
      .sort();
    expect(routes).toEqual(Object.keys(consent).sort());
    for (const [tool, urls] of Object.entries(consent)) {
      for (const url of urls) expect(policy.get("form-action"), `${tool} ${url}`).toContain(new URL(url).origin);
    }
    expect(policy.get("form-action")).toContain("https://accounts.google.com");
    expect(policy.get("form-action")![0]).toBe("'self'");
  });
});

describe("the header (CSP3, CSP enforce CE1, CE2)", () => {
  const production = { NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" };
  const directivesOf = (value: string) => value.split("; ").map((directive) => directive.split(" ")[0]);

  it("is enforced in a production build, but for form-action, which goes report-only beside it", () => {
    const [enforced, reportOnly, reporting] = cspHeaders(production);
    expect(enforced.key).toBe("Content-Security-Policy");
    expect(directivesOf(enforced.value)).not.toContain("form-action");
    expect(enforced.value).toMatch(/^default-src 'self'; script-src .*; frame-ancestors 'none'; report-uri \/api\/csp-report; report-to csp$/);
    expect(reportOnly).toEqual({ key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(production, (directive) => directive === "form-action") });
    expect(directivesOf(reportOnly.value)).toEqual(["form-action", "report-uri", "report-to"]);
    expect(reportOnly.value).toContain("https://abc.supabase.co");
    expect(reporting).toEqual({ key: "Reporting-Endpoints", value: CSP_REPORTING_ENDPOINTS });
    // Between them, every directive of the policy.
    expect(new Set([...directivesOf(enforced.value), ...directivesOf(reportOnly.value)])).toEqual(new Set(directivesOf(contentSecurityPolicy(production))));
    expect(REPORT_ONLY_DIRECTIVES).toEqual(new Set(["form-action"]));
  });

  it("stays report-only in development and where the docs screenshot pages are served, which a local file frames", () => {
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }, { ...production, DOCS_SCREENSHOTS: "1" }]) {
      expect(cspHeaders(env)).toEqual([
        { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(env) },
        { key: "Reporting-Endpoints", value: CSP_REPORTING_ENDPOINTS },
      ]);
    }
  });

  it("is sent on every response, and the extension sign-in page keeps its own frame rule", async () => {
    const headers = await nextConfig.headers!();
    expect(headers[0]).toEqual({ source: "/:path*", headers: cspHeaders(process.env) });
    const extension = headers.find((entry) => entry.source === "/extension/:path*");
    expect(extension?.headers).toContainEqual({ key: "Content-Security-Policy", value: "frame-ancestors 'none'" });
  });
});

describe("reading reports (CSP4)", () => {
  it("reads report-uri's format: directive, blocked origin and the page's first segment only", () => {
    expect(
      cspViolations({
        "csp-report": {
          "document-uri": "https://vestiarion.xyz/p/secret-payee-token?x=1",
          referrer: "https://elsewhere.test/private",
          "violated-directive": "script-src-elem",
          "effective-directive": "script-src-elem",
          "original-policy": "default-src 'self'",
          "blocked-uri": "https://cdn.evil.test/path/script.js?token=abc",
          "script-sample": "alert(document.cookie)",
        },
      })
    ).toEqual([{ directive: "script-src-elem", blocked: "https://cdn.evil.test", page: "/p", disposition: "unknown" }]);
  });

  it("says whether the browser blocked it or only reported it (CSP enforce CE3)", () => {
    const legacy = (disposition: unknown) =>
      cspViolations({ "csp-report": { "blocked-uri": "eval", "effective-directive": "script-src", "document-uri": "https://vestiarion.xyz/docs/x", disposition } })[0];
    expect(legacy("enforce")).toEqual({ directive: "script-src", blocked: "eval", page: "/docs", disposition: "enforce" });
    expect(legacy("report").disposition).toBe("report");
    expect(legacy("anything else").disposition).toBe("unknown");
  });

  it("reads the Reporting API's batches, csp-violation reports only, at most twenty", () => {
    const report = (blockedURL: string, documentURL = "https://vestiarion.xyz/o/acme/bills/123") => ({
      type: "csp-violation",
      url: documentURL,
      body: { documentURL, blockedURL, effectiveDirective: "connect-src", disposition: "report", sample: "secret" },
    });
    expect(cspViolations([report("https://api.example.test/v1/thing"), { type: "deprecation", body: {} }, report("inline", "https://vestiarion.xyz/")])).toEqual([
      { directive: "connect-src", blocked: "https://api.example.test", page: "/o", disposition: "report" },
      { directive: "connect-src", blocked: "inline", page: "/", disposition: "report" },
    ]);
    expect(cspViolations(Array.from({ length: 50 }, () => report("eval")))).toHaveLength(CSP_REPORTS_PER_REQUEST);
  });

  it("leaves out what a browser extension did, keeps only the scheme of what is not a web address, and reads anything odd as unknown", () => {
    expect(cspViolations({ "csp-report": { "blocked-uri": "chrome-extension://abcdef/inject.js", "effective-directive": "script-src" } })).toEqual([]);
    expect(
      cspViolations({ "csp-report": { "blocked-uri": "javascript:alert(1) and more text", "effective-directive": "script-src; drop", "document-uri": "https://x.test/<b>/a" } })
    ).toEqual([{ directive: "unknown", blocked: "javascript", page: "unknown", disposition: "unknown" }]);
    expect(cspViolations({ "csp-report": { "blocked-uri": "data:image/png;base64,AAAA", "violated-directive": "img-src 'self'" } })).toEqual([
      { directive: "img-src", blocked: "data", page: "unknown", disposition: "unknown" },
    ]);
    expect(cspViolations({ nothing: true })).toEqual([]);
    expect(cspViolations("text")).toEqual([]);
  });

  it("never logs more than a short origin, and reads an about: page as no page of this site's", () => {
    const long = `https://${"a".repeat(3000)}.example.test/x`;
    expect(cspViolations({ "csp-report": { "blocked-uri": long, "effective-directive": "img-src" } })).toEqual([
      { directive: "img-src", blocked: "unknown", page: "unknown", disposition: "unknown" },
    ]);
    expect(cspViolations({ "csp-report": { "blocked-uri": `${"z".repeat(40)}:thing`, "effective-directive": "img-src" } })[0].blocked).toBe("unknown");
    expect(cspViolations({ "csp-report": { "blocked-uri": "https://cdn.example.test:8443/a", "document-uri": "about:srcdoc" } })[0]).toMatchObject({
      blocked: "https://cdn.example.test:8443",
      page: "unknown",
    });
    const batch = Array.from({ length: 20 }, () => ({ type: "csp-violation", body: { blockedURL: long, effectiveDirective: "img-src", documentURL: long } }));
    expect(JSON.stringify(cspViolations(batch)).length).toBeLessThan(20 * 105);
  });
});

describe("POST /api/csp-report (CSP4)", () => {
  let ip = 0;
  const post = (body: string, headers: Record<string, string> = {}) => {
    ip += 1;
    return POST(
      new Request(`https://vestiarion.invalid${CSP_REPORT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/csp-report", "x-forwarded-for": `10.9.0.${ip}`, ...headers },
        body,
      })
    );
  };

  afterEach(() => vi.restoreAllMocks());

  it("logs one line per violation and answers 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post(JSON.stringify({ "csp-report": { "document-uri": "https://vestiarion.xyz/docs/x", "effective-directive": "img-src", "blocked-uri": "https://img.example.test/a.png" } }));
    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("csp report", JSON.stringify({ directive: "img-src", blocked: "https://img.example.test", page: "/docs", disposition: "unknown" }));
  });

  it("refuses what is not JSON or too large, and logs nothing for either", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post("not json")).status).toBe(400);
    expect((await post("x".repeat(70 * 1024))).status).toBe(413);
    expect((await post("{}", { "content-length": String(1024 * 1024) })).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stops reading a body sent without its length once it passes the limit", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024).fill(32));
        if (pulled > 100) controller.close();
      },
    });
    ip += 1;
    const response = await POST(new Request(`https://vestiarion.invalid${CSP_REPORT_PATH}`, { method: "POST", headers: { "x-forwarded-for": `10.9.1.${ip}` }, body, duplex: "half" } as RequestInit));
    expect(response.status).toBe(413);
    expect(pulled * 16 * 1024).toBeLessThan(MAX_REPORT_BYTES + 3 * 16 * 1024);
  });

  it("answers 400 to a body the client stops sending", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"csp-report":'));
        controller.error(new Error("connection reset"));
      },
    });
    ip += 1;
    const response = await POST(new Request(`https://vestiarion.invalid${CSP_REPORT_PATH}`, { method: "POST", headers: { "x-forwarded-for": `10.9.2.${ip}` }, body, duplex: "half" } as RequestInit));
    expect(response.status).toBe(400);
  });

  it("drops one client's reports past twenty, answering 204 so the browser does not send them again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = JSON.stringify({ "csp-report": { "blocked-uri": "eval", "effective-directive": "script-src" } });
    const send = () => POST(new Request(`https://vestiarion.invalid${CSP_REPORT_PATH}`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.9" }, body: report }));
    const statuses = [];
    for (let index = 0; index < 22; index += 1) statuses.push((await send()).status);
    expect(statuses.every((status) => status === 204)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(20);
  });

  it("holds every client together to 300 a minute per instance", () => {
    const now = 9_000_000_000_000;
    let allowed = 0;
    for (let index = 0; index < 400; index += 1) if (takeCspReportToken(`10.8.${Math.floor(index / 10)}.${index % 10}`, now)) allowed += 1;
    expect(allowed).toBe(300);
    expect(takeCspReportToken("10.7.0.1", now)).toBe(false);
    expect(takeCspReportToken("10.7.0.1", now + 60_000)).toBe(true);
  });
});
