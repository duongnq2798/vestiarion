import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CONSENT_HISTORY, CONSENT_VERSIONS } from "@/lib/connectors/consent";
import { JIRA_API_HOST, JIRA_AUTH_HOST, JIRA_AUTHORIZE, JIRA_LOGIN, JIRA_RESOURCES, JIRA_TOKEN } from "@/lib/jira/http";
import { JIRA_SCOPES, SCOPES_BY_CONSENT } from "@/lib/jira/settings";

/**
 * Jira's settings, scopes and addresses (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR2, JR3):
 * Jira is on only with both of its variables set, and a deployment that sets one says once which other it lacks, never
 * a value; the four classic scopes are the ones recorded for the consent version a new connection agrees to; and every
 * request goes to Atlassian's two hosts.
 */

const CLIENT_ID = "Qm3tR8vZ1kLp0sXy7wNc4hJd2fGb6aEu";
const CLIENT_SECRET = "ATOAx-secret-of-the-app-Zr9q";

/** The settings module as a new process loads it, with nothing logged yet. */
async function freshSettings() {
  vi.resetModules();
  return import("@/lib/jira/settings");
}

describe("Jira's settings (Jira acceptance JR1)", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("is on with both the client id and the secret, trimmed, and off with neither, saying nothing", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: CLIENT_ID, JIRA_CLIENT_SECRET: CLIENT_SECRET })).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: ` ${CLIENT_ID} `, JIRA_CLIENT_SECRET: `${CLIENT_SECRET}\n` })).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(jiraSettingsFromEnv({})).toBeNull();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: "", JIRA_CLIENT_SECRET: "  " })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the deployment's environment by default", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    vi.stubEnv("JIRA_CLIENT_ID", "");
    vi.stubEnv("JIRA_CLIENT_SECRET", "");
    expect(jiraSettingsFromEnv()).toBeNull();
    vi.stubEnv("JIRA_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("JIRA_CLIENT_SECRET", CLIENT_SECRET);
    expect(jiraSettingsFromEnv()).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it("has no third variable: Jira signs its deliveries with the client secret (JR15)", () => {
    const source = readFileSync("src/lib/jira/settings.ts", "utf8");
    expect([...source.matchAll(/\benv\.([A-Z0-9_]+)/g)].map((match) => match[1])).toEqual(["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"]);
    expect(source).not.toMatch(/JIRA_WEBHOOK_SECRET|JIRA_SIGNING/);
  });

  it("is off with one variable alone, saying once a process which one is not set, and never a value", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: CLIENT_ID })).toBeNull();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_ID: CLIENT_ID, JIRA_CLIENT_SECRET: " " })).toBeNull();
    expect(warn.mock.calls).toEqual([["Jira is off: JIRA_CLIENT_SECRET is not set"]]);
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_SECRET: CLIENT_SECRET })).toBeNull();
    expect(jiraSettingsFromEnv({ JIRA_CLIENT_SECRET: CLIENT_SECRET })).toBeNull();
    expect(warn.mock.calls).toEqual([["Jira is off: JIRA_CLIENT_SECRET is not set"], ["Jira is off: JIRA_CLIENT_ID is not set"]]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(CLIENT_ID);
    expect(logged).not.toContain(CLIENT_SECRET);
  });

  it("takes a client id of 6 to 64 letters, digits, dashes and underscores, and names only the variable when it refuses one", async () => {
    const { jiraSettingsFromEnv } = await freshSettings();
    const withId = (clientId: string) => jiraSettingsFromEnv({ JIRA_CLIENT_ID: clientId, JIRA_CLIENT_SECRET: CLIENT_SECRET });
    expect(withId("a".repeat(6))).not.toBeNull();
    expect(withId("A_b-9".repeat(12) + "Zz09")).not.toBeNull();
    expect(withId("a".repeat(5))).toBeNull();
    expect(withId("a".repeat(65))).toBeNull();
    expect(withId("id with spaces")).toBeNull();
    expect(withId("id/../path")).toBeNull();
    expect(warn.mock.calls).toEqual([["Jira is off: JIRA_CLIENT_ID is not an Atlassian client id"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/aaaaa|spaces|path|ATOAx/);
  });
});

describe("Jira's scopes (JR3)", () => {
  it("are the four classic scopes, with offline_access for a refresh token", () => {
    expect([...JIRA_SCOPES]).toEqual(["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"]);
    // Classic scopes only: a granular one (such as read:issue-details:jira) waits for L13 and a new consent version.
    for (const scope of JIRA_SCOPES) expect(scope, scope).not.toMatch(/:jira$/);
  });

  it("equal the scopes recorded for the consent version a new connection agrees to, so a change of scope needs a new version", () => {
    expect(SCOPES_BY_CONSENT[CONSENT_VERSIONS.jira]).toEqual([...JIRA_SCOPES]);
    expect(Object.keys(SCOPES_BY_CONSENT)).toEqual([...CONSENT_HISTORY.jira]);
    for (const [version, scopes] of Object.entries(SCOPES_BY_CONSENT)) expect(new Set(scopes).size, version).toBe(scopes.length);
  });
});

describe("Atlassian's addresses (JR2, JR8)", () => {
  it("send a person to auth.atlassian.com to authorize, and every request to Atlassian's two hosts", () => {
    expect(JIRA_AUTH_HOST).toBe("auth.atlassian.com");
    expect(JIRA_API_HOST).toBe("api.atlassian.com");
    expect(JIRA_AUTHORIZE).toBe("https://auth.atlassian.com/authorize");
    expect(JIRA_TOKEN).toBe("https://auth.atlassian.com/oauth/token");
    expect(JIRA_RESOURCES).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    // Atlassian's sign-in is named only for the content security policy: no request goes there.
    expect(JIRA_LOGIN).toBe("https://id.atlassian.com");
  });
});
