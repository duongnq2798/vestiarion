import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import SecurityPage, { metadata } from "@/app/security/page";
import sitemap from "@/app/sitemap";
import { COMPACT_FOOTER_LINKS, FOOTER_COLUMNS } from "@/components/vx/SiteChrome";
import { MAINNET_STARTING_TWO_APPROVALS } from "@/lib/mainnet";
import { STATE_TTL_MS } from "@/lib/connectors/state";
import { EXPIRY_MARGIN_MS } from "@/lib/connectors/tokens";
import { REQUEST_TOKEN_TTL_SECONDS } from "@/lib/dal/request-token";
import { SVIX_TOLERANCE_S } from "@/lib/email-inbox/verify";
import { SANDBOX_IDLE_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS } from "@/lib/platform/cleanup";
import { MAINNET_STARTING_BUDGET } from "@/lib/platform/workspace";
import { loginRedirectFor, requiresSession } from "@/lib/auth/routes";
import { publicOrigin } from "@/lib/public-origin";
import { ISSUES_URL, SECURITY_POLICY_URL } from "@/lib/site-links";
import { SLACK_SIGNATURE_TOLERANCE_S } from "@/lib/slack/verify";
import { SUBPROCESSORS, SUBPROCESSORS_AS_OF } from "@/lib/subprocessors";
import { WEBHOOK_DISABLE_AFTER, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TIMEOUT_MS } from "@/lib/webhooks/deliver";

/**
 * /security: a public, static page for security reviewers that says only what the code does. Where it quotes a figure
 * or a setting, the test reads it from the code; its subprocessors are the privacy page's services, name for name; and
 * what it says it does not do yet is checked to still be undone, so the page is changed when the code is.
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

const markup = renderToStaticMarkup(<SecurityPage />);
const body = text(markup);
const privacyMarkup = renderToStaticMarkup(<PrivacyPage />);
const privacy = text(privacyMarkup);
const section = (id: string) => text(markup.split(`id="${id}"`)[1]?.split("<section")[0] ?? "");

describe("/security", () => {
  it("has a title, a description and its canonical address", () => {
    expect(metadata.title).toBe("Security");
    expect(typeof metadata.description === "string" && metadata.description.length > 20).toBe(true);
    expect(metadata.alternates?.canonical).toBe("/security");
  });

  it("renders its heading, the date it was last updated, the site header and the compact footer", () => {
    expect(markup).toMatch(/<h1[^>]*>Security<\/h1>/);
    expect(body).toContain("Last updated 2026-10-15");
    expect(markup).toMatch(/<header[^>]*class="sticky top-0/);
    for (const href of ["/terms", "/privacy", "/security"]) expect(markup).toContain(`href="${href}"`);
  });

  it("has every part a reviewer looks for, each an anchor", () => {
    for (const [id, title] of [
      ["architecture", "Architecture and data flow"],
      ["isolation", "Tenant isolation"],
      ["encryption", "Encryption"],
      ["access", "Access control"],
      ["api", "API keys, the API and the MCP server"],
      ["connectors", "Connected tools and their tokens"],
      ["webhooks", "Webhooks"],
      ["audit", "The signed ledger"],
      ["retention", "Data retention and deletion"],
      ["ai", "AI use"],
      ["subprocessors", "Subprocessors"],
      ["development", "Secure development"],
      ["incidents", "Incident response"],
      ["report", "Reporting a vulnerability"],
      ["not-claimed", "What we do not claim"],
    ]) {
      expect(markup, id).toMatch(new RegExp(`<h2 id="${id}"[^>]*>${title}</h2>`));
    }
  });

  it("is static and needs no session", () => {
    expect(SecurityPage.constructor.name).toBe("Function");
    expect(source("src/app/security/page.tsx")).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    expect(requiresSession("/security")).toBe(false);
    expect(loginRedirectFor("/security", "", false)).toBeNull();
  });

  it("is linked from both footers, from the privacy page and from the controls guide, and listed in the sitemap", () => {
    expect(FOOTER_COLUMNS.find((column) => column.title === "Legal")?.links).toContainEqual({ href: "/security", label: "Security" });
    expect(COMPACT_FOOTER_LINKS).toContainEqual({ href: "/security", label: "Security" });
    expect(privacyMarkup.split('id="contact"')[1]).toContain('href="/security"');
    expect(source("content/docs/guides/controls.mdx")).toContain("](/security)");
    expect(sitemap().map((entry) => entry.url)).toContain(`${publicOrigin()}/security`);
  });

  it("never plays the network down", () => {
    expect(body).not.toMatch(/real money|not real|fake money|play money|worthless/i);
  });
});

describe("the subprocessors", () => {
  const services = privacyMarkup.split('id="services"')[1]?.split("</section>")[0] ?? "";
  /** Each top-level entry's name on the privacy page: the <strong> an item of the list opens with. */
  const privacyEntries = new Set([...services.matchAll(/<li>\s*<strong>([^<]+)<\/strong>/g)].map((match) => text(match[1])));

  it("are dated", () => {
    expect(SUBPROCESSORS_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(section("subprocessors")).toContain(`As of ${SUBPROCESSORS_AS_OF}`);
  });

  it("are each listed on the page, with what they do and what they receive", () => {
    const list = markup.split('id="subprocessors"')[1]?.split("</section>")[0] ?? "";
    /** Each item's words, its tags dropped without a space, as a reader sees them. */
    const items = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1].replace(/<[^>]+>/g, "")));
    expect(items).toHaveLength(SUBPROCESSORS.length);
    for (const [index, service] of SUBPROCESSORS.entries()) {
      expect(items[index], service.name).toContain(`${service.name}: ${service.purpose}`);
      expect(items[index], service.name).toContain(`Data: ${service.data}.`);
    }
  });

  it("are each an entry of the privacy page's services, and every service there is one of them", () => {
    const entries = new Set(SUBPROCESSORS.map((service) => service.privacyEntry));
    for (const entry of entries) expect(privacyEntries, `${entry} is on /security but not under the privacy page's services`).toContain(entry);
    for (const entry of privacyEntries) expect(entries, `${entry} is a service on the privacy page but not a subprocessor on /security`).toContain(entry);
  });

  it("name nobody the privacy page does not, and the reverse", () => {
    for (const service of SUBPROCESSORS) {
      for (const name of service.names) {
        expect(privacy, `${name} on the privacy page`).toContain(name);
        expect(body, `${name} on /security`).toContain(name);
      }
    }
  });

  it("name every model provider the agent can call, as decide.ts builds them", () => {
    const decide = source("src/lib/agent/decide.ts");
    for (const [provider, name] of [
      ["anthropic", "Anthropic"],
      ["openai", "OpenAI"],
      ["deepseek", "DeepSeek"],
    ]) {
      expect(decide, provider).toContain(`"${provider}"`);
      expect(section("subprocessors"), name).toContain(name);
      expect(section("ai"), name).toContain(name);
    }
  });
});

describe("the figures and settings it quotes, as the code has them", () => {
  it("a request's token lives 5 minutes, as the data access layer mints it", () => {
    expect(REQUEST_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(section("isolation")).toContain("expires after 5 minutes");
    expect(section("isolation")).toContain("There is no fallback to the service role");
    const tenant = source("src/lib/dal/tenant-client.ts");
    expect(tenant).toContain("createClient(database.url, database.anonKey, {");
    expect(tenant).not.toContain("serviceRoleKey");
  });

  it("the restrictive policy and the browser roles, as the migrations write them", () => {
    expect(source("supabase/migrations/0018_tenant_role_rls.sql")).toMatch(/as restrictive\s+for all to vestiarion_tenant/);
    expect(source("supabase/migrations/0101_accounting_connectors.sql")).toContain(
      "revoke all privileges on table public.accounting_tokens from anon, authenticated, vestiarion_tenant"
    );
    expect(section("isolation")).toContain("restrictive policy");
  });

  it("the cipher, its IV and what binds a ciphertext, as secrets.ts and the token store seal them", () => {
    const secrets = source("src/lib/secrets.ts");
    expect(secrets).toContain('createCipheriv("aes-256-gcm"');
    expect(secrets).toContain("crypto.randomBytes(12)");
    expect(secrets).toContain("`${context.orgId}:${context.column}`");
    expect(source("src/lib/connectors/token-store.ts")).toContain("const columnOf = (base: string, id: string) => `${base}/${id}`;");
    expect(source("src/lib/platform/webhooks.ts")).toContain("webhook_secret:");
    expect(section("encryption")).toContain("AES-256-GCM and a fresh 96-bit IV");
  });

  it("an API key: its prefix, its hash, its limit and its writes", () => {
    const keys = source("src/lib/platform/api-keys.ts");
    expect(keys).toContain('createHash("sha256")');
    expect(keys).toContain("timingSafeEqual");
    expect(keys).toContain("already has 20 API keys");
    expect(source("src/lib/rate-limit.ts")).toContain("return take(apiWriteBuckets, keyId, 30, 2_000, now);");
    const api = section("api");
    for (const phrase of ["vxk_", "8-character prefix", "256-bit secret", "SHA-256", "at most 20", "30 a minute"]) expect(api, phrase).toContain(phrase);
  });

  it("the API's writes: four, none of which approves or pays", () => {
    const routes = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? routes(full) : entry.name === "route.ts" ? [full] : [];
      });
    const writes = routes(path.join(process.cwd(), "src/app/api/v1")).filter((file) => /export (async function|const) (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(file, "utf8")));
    expect(writes.map((file) => path.relative(path.join(process.cwd(), "src/app/api/v1"), file).split(path.sep)[0]).sort()).toEqual([
      "counterparties",
      "invoices",
      "milestones",
      "payee-links",
    ]);
    expect(section("api")).toContain("No request approves a payment, moves money, or changes or removes a record");
  });

  it("connector tokens: the state's life, the refresh margin and the lease", () => {
    expect(STATE_TTL_MS).toBe(10 * 60_000);
    expect(EXPIRY_MARGIN_MS).toBe(60_000);
    expect(source("supabase/migrations/0101_accounting_connectors.sql")).toContain("accounting_token_lease");
    const connectors = section("connectors");
    expect(connectors).toContain("expires after 10 minutes");
    expect(connectors).toContain("refreshed a minute before it expires, under a lease");
  });

  it("webhooks: the windows Slack's and Resend's signatures are held to, and the deliveries", () => {
    expect(SLACK_SIGNATURE_TOLERANCE_S).toBe(300);
    expect(SVIX_TOLERANCE_S).toBe(300);
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
    const webhooks = section("webhooks");
    expect(webhooks).toContain("more than 5 minutes away");
    expect(webhooks).toContain(`waits at most ${WEBHOOK_TIMEOUT_MS / 1000} seconds and is tried up to ${WEBHOOK_MAX_ATTEMPTS} times`);
    expect(webhooks).toContain(`fails ${WEBHOOK_DISABLE_AFTER} times in a row is disabled`);
    expect(source("src/lib/platform/webhooks.ts")).toContain("already has 5 webhook endpoints");
    expect(webhooks).toContain("at most 5 endpoints");
    expect(source("src/lib/webhooks/sign.ts")).toContain("Vestiarion-Signature");
    expect(source("src/lib/circle/notifications.ts")).toContain("ECDSA P-256");
  });

  it("the starting figures of a workspace on Arc mainnet", () => {
    const access = section("access");
    expect(access).toContain(`two approvals above ${MAINNET_STARTING_TWO_APPROVALS} USDC`);
    expect(access).toContain(`${MAINNET_STARTING_BUDGET.dailyUsdc} USDC a day and ${MAINNET_STARTING_BUDGET.weeklyUsdc} USDC in 7 days`);
  });

  it("the self-approval rule and its one exception, as the database refuses it", () => {
    expect(source("supabase/migrations/0118_commissions.sql")).toContain("if v.created_by = p_by and not public.sole_approver(p_org_id, p_by) then");
    expect(section("access")).toContain("the only owner, admin or approver");
  });

  it("the payments switch's reach, as payments-switch.ts reads it", () => {
    expect(source("src/lib/payments-switch.ts")).toContain("const SWITCH_TTL_MS = 10_000;");
    expect(section("incidents")).toContain("within 10 seconds");
  });

  it("retention, as the cleanup has it", () => {
    const retention = section("retention");
    expect(retention).toContain(`${SANDBOX_IDLE_DAYS} days`);
    expect(retention).toContain(`${WEBHOOK_DELIVERY_RETENTION_DAYS} days`);
  });
});

describe("what it does not claim, still true of the code", () => {
  const notClaimed = section("not-claimed");

  it("the contracts are not audited, as their source says", () => {
    for (const file of ["contracts/VestiarionSpendingLimit.sol", "contracts/VestiarionEscrow.sol"]) expect(source(file), file).toContain("not audited");
    expect(notClaimed).toContain("have not been audited");
  });

  it("no attestation", () => {
    expect(notClaimed).toContain("no SOC 2 report or ISO 27001 certification");
  });

  it("no Content Security Policy yet: when one is added, this page says so", () => {
    expect(source("next.config.ts")).not.toMatch(/Content-Security-Policy/i);
    expect(existsSync(path.join(process.cwd(), "vercel.json"))).toBe(false);
    expect(notClaimed).toContain("does not send a Content Security Policy yet");
  });

  it("no automated dependency updates: when they are turned on, this page says so", () => {
    expect(existsSync(path.join(process.cwd(), ".github/dependabot.yml"))).toBe(false);
    expect(notClaimed).toContain("Dependencies are not updated automatically");
  });
});

describe("reporting a vulnerability", () => {
  const policy = source("SECURITY.md");

  it("asks for a contact issue with no details, and links the policy", () => {
    const report = markup.split('id="report"')[1] ?? "";
    expect(report).toContain(`href="${ISSUES_URL}"`);
    expect(report).toContain(`href="${SECURITY_POLICY_URL}"`);
    expect(text(report)).toContain("do not put the details of a vulnerability in a public issue");
    expect(text(report)).toContain("Security contact");
  });

  it("matches SECURITY.md, which names the same contact and links back here", () => {
    expect(policy).toContain("**Security contact**");
    expect(policy).toContain(ISSUES_URL);
    expect(policy).toContain("https://www.vestiarion.xyz/security");
    expect(policy).toMatch(/do not put the details of a vulnerability in a public issue/i);
    for (const heading of ["## Supported versions", "## Reporting a vulnerability", "## What to expect", "## Scope"]) expect(policy, heading).toContain(heading);
  });

  it("supports the hosted service and the latest release, without naming one that goes stale", () => {
    expect(policy).toContain("The latest beta release");
    expect(policy).toContain("https://github.com/duongnq2798/vestiarion/releases/latest");
    expect(policy).not.toMatch(/v\d+\.\d+\.\d+-beta\.\d+/);
  });
});
