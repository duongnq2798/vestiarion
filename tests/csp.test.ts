import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { POST } from "@/app/api/csp-report/route";
import { ASANA_AUTHORIZE } from "@/lib/asana/http";
import { HUBSPOT_AUTHORIZE } from "@/lib/hubspot/http";
import { NETWORKS } from "@/lib/network";
import { PIPEDRIVE_AUTHORIZE } from "@/lib/pipedrive/http";
import { contentSecurityPolicy, CSP_REPORT_PATH, CSP_REPORTING_ENDPOINTS, CSP_REPORTS_PER_REQUEST, cspViolations } from "@/lib/security/csp";
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

  it("allows eval in development only, where React uses it", () => {
    expect(directives(contentSecurityPolicy({ NODE_ENV: "development" })).get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
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

  it("lets each connect form end at its tool's consent screen, and Continue with Google at Google", () => {
    for (const authorize of [HUBSPOT_AUTHORIZE, ASANA_AUTHORIZE, PIPEDRIVE_AUTHORIZE, `${ZOHO_REGIONS.us.accounts}/oauth/v2/auth`]) {
      expect(policy.get("form-action"), authorize).toContain(new URL(authorize).origin);
    }
    expect(policy.get("form-action")).toContain("https://accounts.google.com");
    expect(policy.get("form-action")![0]).toBe("'self'");
  });
});

describe("the header (CSP3)", () => {
  it("is sent report-only on every response, with the Reporting API's endpoint", async () => {
    const headers = await nextConfig.headers!();
    expect(headers[0]).toEqual({
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy() },
        { key: "Reporting-Endpoints", value: CSP_REPORTING_ENDPOINTS },
      ],
    });
    // Nothing enforces it yet but the extension sign-in page's frame rule.
    const enforced = headers.flatMap((entry) => entry.headers.filter((header) => header.key === "Content-Security-Policy").map(() => entry.source));
    expect(enforced).toEqual(["/extension/:path*"]);
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
    ).toEqual([{ directive: "script-src-elem", blocked: "https://cdn.evil.test", page: "/p" }]);
  });

  it("reads the Reporting API's batches, csp-violation reports only, at most twenty", () => {
    const report = (blockedURL: string, documentURL = "https://vestiarion.xyz/o/acme/bills/123") => ({
      type: "csp-violation",
      url: documentURL,
      body: { documentURL, blockedURL, effectiveDirective: "connect-src", disposition: "report", sample: "secret" },
    });
    expect(cspViolations([report("https://api.example.test/v1/thing"), { type: "deprecation", body: {} }, report("inline", "https://vestiarion.xyz/")])).toEqual([
      { directive: "connect-src", blocked: "https://api.example.test", page: "/o" },
      { directive: "connect-src", blocked: "inline", page: "/" },
    ]);
    expect(cspViolations(Array.from({ length: 50 }, () => report("eval")))).toHaveLength(CSP_REPORTS_PER_REQUEST);
  });

  it("leaves out what a browser extension did, keeps only the scheme of what is not a web address, and reads anything odd as unknown", () => {
    expect(cspViolations({ "csp-report": { "blocked-uri": "chrome-extension://abcdef/inject.js", "effective-directive": "script-src" } })).toEqual([]);
    expect(
      cspViolations({ "csp-report": { "blocked-uri": "javascript:alert(1) and more text", "effective-directive": "script-src; drop", "document-uri": "https://x.test/<b>/a" } })
    ).toEqual([{ directive: "unknown", blocked: "javascript", page: "unknown" }]);
    expect(cspViolations({ "csp-report": { "blocked-uri": "data:image/png;base64,AAAA", "violated-directive": "img-src 'self'" } })).toEqual([
      { directive: "img-src", blocked: "data", page: "unknown" },
    ]);
    expect(cspViolations({ nothing: true })).toEqual([]);
    expect(cspViolations("text")).toEqual([]);
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
    expect(warn).toHaveBeenCalledWith("csp report-only", JSON.stringify({ directive: "img-src", blocked: "https://img.example.test", page: "/docs" }));
  });

  it("refuses what is not JSON or too large, and logs nothing for either", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post("not json")).status).toBe(400);
    expect((await post("x".repeat(70 * 1024))).status).toBe(413);
    expect((await post("{}", { "content-length": String(1024 * 1024) })).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("slows one client down after twenty reports", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = () =>
      POST(new Request(`https://vestiarion.invalid${CSP_REPORT_PATH}`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.9" }, body: "[]" }));
    const statuses = [];
    for (let index = 0; index < 21; index += 1) statuses.push((await send()).status);
    expect(statuses.slice(0, 20).every((status) => status === 204)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
