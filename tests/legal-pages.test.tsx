import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";
import sitemap from "@/app/sitemap";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import { ORG_ROLES } from "@/lib/auth/roles";
import { loginRedirectFor, requiresSession } from "@/lib/auth/routes";
import { SANDBOX_IDLE_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS } from "@/lib/platform/cleanup";
import { publicOrigin } from "@/lib/public-origin";
import { ISSUES_URL } from "@/lib/site-links";

/**
 * /terms and /privacy (spec §2, F2): public, static pages that say only what
 * the code does. Where a statement is a number or a setting in the code, the
 * test reads it from the code, so the page cannot drift from it unnoticed.
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PAGES = [
  { path: "/terms", file: "src/app/terms/page.tsx", Page: TermsPage, metadata: termsMetadata, heading: "Terms of use" },
  { path: "/privacy", file: "src/app/privacy/page.tsx", Page: PrivacyPage, metadata: privacyMetadata, heading: "Privacy" },
] as const;

describe.each(PAGES)("$path", ({ path: route, file, Page, metadata, heading }) => {
  const markup = renderToStaticMarkup(<Page />);

  it("has a title and a description", () => {
    expect(metadata.title).toBeTruthy();
    expect(typeof metadata.description === "string" && metadata.description.length > 20).toBe(true);
    expect(metadata.alternates?.canonical).toBe(route);
  });

  it("renders its heading, the date it was last updated, the site header and the compact footer", () => {
    expect(markup).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
    expect(text(markup)).toContain("Last updated 2026-09-30");
    expect(markup).toMatch(/<time datetime="2026-09-30">2026-09-30<\/time>/i);
    expect(markup).toMatch(/<header[^>]*class="sticky top-0/);
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
  });

  it("names Arc testnet, and points questions at GitHub Issues", () => {
    expect(text(markup)).toContain("Arc testnet");
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${ISSUES_URL}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`));
  });

  it("never plays the network down", () => {
    expect(text(markup)).not.toMatch(/real money|not real|fake money|play money|worthless/i);
  });

  it("is static: a plain function, reading no request", () => {
    expect(Page.constructor.name).toBe("Function");
    expect(source(file)).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
  });

  it("needs no session", () => {
    expect(requiresSession(route)).toBe(false);
    expect(loginRedirectFor(route, "", false)).toBeNull();
  });
});

describe("the terms", () => {
  const body = text(renderToStaticMarkup(<TermsPage />));

  it.each([
    "Arc testnet",
    "as is",
    "MIT License",
    "Circle credentials",
    "addresses",
    "guardrails",
    "hosted wallets",
    "faucet",
    "another workspace",
    "approve",
  ])("cover %s", (phrase) => {
    expect(body.toLowerCase()).toContain(phrase.toLowerCase());
  });
});

describe("the privacy page", () => {
  const body = text(renderToStaticMarkup(<PrivacyPage />));

  it("names each service that receives data", () => {
    for (const name of ["Supabase", "Vercel", "Circle", "Resend", "Google Analytics", "Anthropic", "OpenAI", "DeepSeek", "OpenSanctions", "GitHub"]) {
      expect(body, name).toContain(name);
    }
  });

  it("states the sandbox cleanup's threshold as the code has it", () => {
    expect(body).toContain(`${SANDBOX_IDLE_DAYS} days`);
  });

  it("states the webhook delivery retention as the code has it", () => {
    expect(body).toContain(`${WEBHOOK_DELIVERY_RETENTION_DAYS} days`);
  });

  it("names every workspace role", () => {
    for (const role of ORG_ROLES) expect(body.toLowerCase(), role).toContain(role);
  });

  it("says what Google Analytics is kept from, and the code keeps it from exactly that", () => {
    const analytics = source("src/components/analytics/GoogleAnalytics.tsx");
    expect(analytics).toContain("allow_google_signals: false");
    expect(analytics).toContain("allow_ad_personalization_signals: false");
    expect(analytics).toContain("send_page_view: false");
    const redact = source("src/lib/analytics/redact.ts");
    expect(redact).toContain('"/invite/:token"');
    expect(redact).toContain('"/o/:org"');
    for (const phrase of ["/invite/:token", "/o/:org", "Google signals", "ad personalization", "query string", "origin"]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it("says API keys are kept only as a SHA-256 hash, as the code keeps them", () => {
    expect(source("src/lib/platform/api-keys.ts")).toContain('createHash("sha256")');
    expect(body).toContain("SHA-256");
  });

  it("says secrets are encrypted with AES-256-GCM, as the code encrypts them", () => {
    expect(source("src/lib/secrets.ts")).toContain("aes-256-gcm");
    expect(body).toContain("AES-256-GCM");
  });

  it("lists what a deleted workspace's tombstone keeps, as migration 0031 writes it", () => {
    const migration = source("supabase/migrations/0031_delete_org.sql");
    for (const column of ["slug", "name", "deleted_by", "deleted_at", "ledger_entries", "ledger_head_hash", "ledger_signing_key_id"]) {
      expect(migration).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
    for (const phrase of ["slug", "name", "who deleted it", "when", "length", "head hash", "signing key"]) {
      expect(body, phrase).toContain(phrase);
    }
  });
});

describe("the sitemap", () => {
  it("lists the terms and the privacy page", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${publicOrigin()}/terms`);
    expect(urls).toContain(`${publicOrigin()}/privacy`);
  });
});
