import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appJwt,
  createPullRequestComment,
  exchangeUserCode,
  GitHubError,
  installationToken,
  repositoryInstallationId,
  repositoryPermission,
  userInstallations,
} from "@/lib/github/app";
import { githubAppSettingsFromEnv, githubCallbackUri, type GitHubAppSettings } from "@/lib/github/settings";

/**
 * The platform's GitHub App (docs/superpowers/specs/2026-10-04-github-app-design.md G1, G7): its settings from the
 * environment, and each call it makes to GitHub, against a recorded fetch.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = {
  GITHUB_APP_ID: "1234567",
  GITHUB_APP_SLUG: "vestiarion-payments",
  GITHUB_APP_CLIENT_ID: "Iv23liAbCdEf0123456789",
  GITHUB_APP_CLIENT_SECRET: "client-secret-value",
  GITHUB_APP_PRIVATE_KEY: PEM,
};
const settings = githubAppSettingsFromEnv(ENV) as GitHubAppSettings;
const NOW = Date.parse("2026-10-04T08:00:00Z");

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string };
function recorder(reply: (sent: Sent) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Sent = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    sent.push(call);
    const { status, body } = reply(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

function decodeJwt(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

describe("githubAppSettingsFromEnv", () => {
  it("reads all five variables", () => {
    expect(settings).toMatchObject({ appId: "1234567", slug: "vestiarion-payments", clientId: "Iv23liAbCdEf0123456789", clientSecret: "client-secret-value" });
    expect(settings.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it.each(Object.keys(ENV))("is off without %s", (name) => {
    expect(githubAppSettingsFromEnv({ ...ENV, [name]: "" })).toBeNull();
  });

  it("is off for an app id that is not a number, a slug that is not one, or a key that is not a private key", () => {
    expect(githubAppSettingsFromEnv({ ...ENV, GITHUB_APP_ID: "vestiarion" })).toBeNull();
    expect(githubAppSettingsFromEnv({ ...ENV, GITHUB_APP_SLUG: "Vestiarion Payments" })).toBeNull();
    expect(githubAppSettingsFromEnv({ ...ENV, GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" })).toBeNull();
  });

  it("reads a key whose newlines arrived as the two characters \\n, as hosting dashboards keep them (G7)", () => {
    const flattened = githubAppSettingsFromEnv({ ...ENV, GITHUB_APP_PRIVATE_KEY: PEM.trim().replaceAll("\n", "\\n") });
    expect(flattened?.privateKey).toBe(PEM.trim());
  });

  it("takes the app's public link for its slug too, since that is where the slug is read from", () => {
    for (const link of ["https://github.com/apps/vestiarion-payments", "https://github.com/apps/vestiarion-payments/"]) {
      expect(githubAppSettingsFromEnv({ ...ENV, GITHUB_APP_SLUG: link })?.slug).toBe("vestiarion-payments");
    }
    expect(githubAppSettingsFromEnv({ ...ENV, GITHUB_APP_SLUG: "https://example.com/apps/vestiarion-payments" })).toBeNull();
  });

  it("calls back to the deployment's own route", () => {
    expect(githubCallbackUri("https://www.vestiarion.xyz")).toBe("https://www.vestiarion.xyz/api/github/callback");
  });
});

describe("appJwt", () => {
  it("is RS256, issued by the app a minute back and good for nine minutes, and signed with its key", () => {
    const jwt = decodeJwt(appJwt(settings, NOW));
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.payload).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: "1234567" });
    expect(crypto.verify("RSA-SHA256", Buffer.from(jwt.signed), publicKey, jwt.signature)).toBe(true);
  });
});

describe("the app's calls", () => {
  it("gets an installation token with the app's JWT", async () => {
    const { sent, fetchImpl } = recorder(() => ({ status: 201, body: { token: "ghs_installation", expires_at: "2026-10-04T09:00:00Z" } }));
    expect(await installationToken(settings, 42, { fetchImpl, now: () => NOW })).toBe("ghs_installation");
    expect(sent[0]).toMatchObject({ url: "https://api.github.com/app/installations/42/access_tokens", method: "POST" });
    expect(sent[0].headers.authorization).toMatch(/^Bearer ey/);
    expect(sent[0].headers.accept).toBe("application/vnd.github+json");
  });

  it("finds a repository's installation, and none when the app is not installed there", async () => {
    const installed = recorder(() => ({ status: 200, body: { id: 42, account: { login: "acme" } } }));
    expect(await repositoryInstallationId(settings, "acme", "app", { fetchImpl: installed.fetchImpl, now: () => NOW })).toBe(42);
    expect(installed.sent[0]).toMatchObject({ url: "https://api.github.com/repos/acme/app/installation", method: "GET" });
    const missing = recorder(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await repositoryInstallationId(settings, "acme", "app", { fetchImpl: missing.fetchImpl, now: () => NOW })).toBeNull();
  });

  it("exchanges a person's code for their token, and gives null when GitHub refuses the code", async () => {
    const ok = recorder(() => ({ status: 200, body: { access_token: "ghu_person", token_type: "bearer" } }));
    expect(await exchangeUserCode(settings, "code-1", "https://www.vestiarion.xyz/api/github/callback", { fetchImpl: ok.fetchImpl })).toBe("ghu_person");
    expect(ok.sent[0]).toMatchObject({ url: "https://github.com/login/oauth/access_token", method: "POST" });
    expect(ok.sent[0].headers.accept).toBe("application/json");
    expect(JSON.parse(ok.sent[0].body!)).toEqual({
      client_id: "Iv23liAbCdEf0123456789",
      client_secret: "client-secret-value",
      code: "code-1",
      redirect_uri: "https://www.vestiarion.xyz/api/github/callback",
    });
    const refused = recorder(() => ({ status: 200, body: { error: "bad_verification_code" } }));
    expect(await exchangeUserCode(settings, "stale", "https://x.test/api/github/callback", { fetchImpl: refused.fetchImpl })).toBeNull();
  });

  it("lists the app's installations a person can reach, with their token", async () => {
    const { sent, fetchImpl } = recorder(() => ({
      status: 200,
      body: { total_count: 1, installations: [{ id: 42, account: { login: "acme", type: "Organization" }, repository_selection: "selected" }] },
    }));
    expect(await userInstallations("ghu_person", { fetchImpl })).toEqual([{ id: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected" }]);
    expect(sent[0]).toMatchObject({ url: "https://api.github.com/user/installations?per_page=100", method: "GET" });
    expect(sent[0].headers.authorization).toBe("Bearer ghu_person");
  });

  it("comments on a pull request with an installation token", async () => {
    const { sent, fetchImpl } = recorder(() => ({ status: 201, body: { id: 7, html_url: "https://github.com/acme/app/pull/42#issuecomment-7" } }));
    const ref = { owner: "acme", repo: "app", number: 42, url: "https://github.com/acme/app/pull/42" };
    expect(await createPullRequestComment("ghs_installation", ref, "Paid.", { fetchImpl })).toEqual({ id: 7, url: "https://github.com/acme/app/pull/42#issuecomment-7" });
    expect(sent[0]).toMatchObject({ url: "https://api.github.com/repos/acme/app/issues/42/comments", method: "POST" });
    expect(sent[0].headers.authorization).toBe("Bearer ghs_installation");
    expect(JSON.parse(sent[0].body!)).toEqual({ body: "Paid." });
  });

  it("reads a person's permission on a repository, with an installation token (bounties B4)", async () => {
    const { sent, fetchImpl } = recorder(() => ({ status: 200, body: { permission: "write", role_name: "maintain", user: { login: "maintainer-1" } } }));
    expect(await repositoryPermission("ghs_installation", "Acme", "app", "maintainer-1", { fetchImpl })).toBe("write");
    expect(sent[0]).toMatchObject({ url: "https://api.github.com/repos/Acme/app/collaborators/maintainer-1/permission", method: "GET" });
    expect(sent[0].headers.authorization).toBe("Bearer ghs_installation");
  });

  it("reads someone GitHub does not know on the repository as having no permission, and anything unexpected as none", async () => {
    const missing = recorder(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await repositoryPermission("ghs_installation", "acme", "app", "stranger", { fetchImpl: missing.fetchImpl })).toBe("none");
    const odd = recorder(() => ({ status: 200, body: { permission: "superuser" } }));
    expect(await repositoryPermission("ghs_installation", "acme", "app", "someone", { fetchImpl: odd.fetchImpl })).toBe("none");
  });

  it("throws a GitHubError naming the status, and never the token, when GitHub refuses", async () => {
    const { fetchImpl } = recorder(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    const ref = { owner: "acme", repo: "app", number: 42, url: "https://github.com/acme/app/pull/42" };
    const error = await createPullRequestComment("ghs_secret_token", ref, "Paid.", { fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 403 });
    expect(String((error as Error).message)).toContain("403");
    expect(String((error as Error).message)).not.toContain("ghs_secret_token");
  });
});
