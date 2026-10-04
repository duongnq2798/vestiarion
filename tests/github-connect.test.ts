import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackRoute } from "@/app/api/github/callback/route";
import { GET as installRoute } from "@/app/api/github/install/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect } from "@/lib/github/connect";
import { installState, readInstallState } from "@/lib/github/state";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to GitHub (docs/superpowers/specs/2026-10-04-github-app-design.md G2): only an owner or admin,
 * signed in, starts it; the state GitHub carries back is signed, recent, and names the person whose browser holds its
 * nonce; and an installation counts only when GitHub, asked with that person's own token, lists it as theirs.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn(), exchange: vi.fn(), installations: vi.fn(), save: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));
vi.mock("@/lib/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/app")>()),
  exchangeUserCode: mocks.exchange,
  userInstallations: mocks.installations,
}));
vi.mock("@/lib/github/installs", () => ({ saveInstallation: mocks.save }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d81";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d82";
const OTHER_USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d83";
const ORIGIN = "https://www.vestiarion.xyz";
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SETTINGS = {
  appId: "1234567",
  slug: "vestiarion-payments",
  clientId: "Iv23liAbCdEf0123456789",
  clientSecret: "client-secret-value",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
// Master keys in the environment while each test runs, which the state is signed with, and the workspace's row.
const orgs = signedOrgs();
const INSTALLATION = { id: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected" as const };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "admin" });
  mocks.exchange.mockResolvedValue("ghu_person_token");
  mocks.installations.mockResolvedValue([INSTALLATION]);
  mocks.save.mockResolvedValue(undefined);
});

function world() {
  const fake = fakeSupabase((sent: RecordedRequest) =>
    sent.path === "/rest/v1/orgs" ? { body: sent.params.get("select") === "slug" ? { slug: "acme" } : orgs.orgRow(ORG, { slug: "acme" }) } : { body: [] }
  );
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);

describe("startConnect", () => {
  it("sends an owner or admin to install the app, with a signed state whose nonce is in their cookie", async () => {
    const { run } = world();
    const response = await run(() => startConnect(new Request(`${ORIGIN}/api/github/install?org=acme`), { settings: SETTINGS, origin: ORIGIN }));
    expect(response.status).toBe(302);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/apps/vestiarion-payments/installations/new");
    const state = readInstallState(to.searchParams.get("state") ?? "", keys());
    expect(state).toMatchObject({ org: ORG, user: USER });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_github_install=${state?.nonce}`);
    expect(cookie).toMatch(/Path=\/api\/github/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("sends anyone else back to Settings, and GitHub is never asked", async () => {
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "approver" });
    const { run } = world();
    const response = await run(() => startConnect(new Request(`${ORIGIN}/api/github/install?org=acme`), { settings: SETTINGS, origin: ORIGIN }));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?github=forbidden#github`);

    mocks.session.mockResolvedValue(null);
    const signedOut = await run(() => startConnect(new Request(`${ORIGIN}/api/github/install?org=acme`), { settings: SETTINGS, origin: ORIGIN }));
    expect(location(signedOut).pathname).toBe("/o/acme/settings");
    expect(signedOut.headers.get("set-cookie")).toBeNull();
  });

  it("answers 404 to a workspace name that is not one", async () => {
    const { run } = world();
    expect((await run(() => startConnect(new Request(`${ORIGIN}/api/github/install?org=../x`), { settings: SETTINGS, origin: ORIGIN }))).status).toBe(404);
  });

  it("is not there when the GitHub App is not configured (G9)", async () => {
    expect((await installRoute(new Request(`${ORIGIN}/api/github/install?org=acme`))).status).toBe(404);
    expect((await callbackRoute(new Request(`${ORIGIN}/api/github/callback?code=x`))).status).toBe(404);
  });
});

describe("finishConnect", () => {
  function callback(fields: Record<string, string | undefined>, cookie?: string) {
    const url = new URL(`${ORIGIN}/api/github/callback`);
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) url.searchParams.set(key, value);
    return new Request(url, { headers: cookie ? { cookie } : {} });
  }
  const started = (user = USER, nowMs?: number) => {
    const nonce = "n".repeat(43);
    return { state: installState({ org: ORG, user, nonce }, keys(), nowMs), cookie: `other=1; vx_github_install=${nonce}` };
  };
  const finish = (request: Request) => world().run(() => finishConnect(request, { settings: SETTINGS, origin: ORIGIN }));

  it("checks the installation with GitHub as the person, saves it, and returns them to Settings", async () => {
    const { state, cookie } = started();
    const response = await finish(callback({ state, code: "code-1", installation_id: "42", setup_action: "install" }, cookie));

    expect(mocks.exchange).toHaveBeenCalledWith(SETTINGS, "code-1", `${ORIGIN}/api/github/callback`, { fetchImpl: undefined });
    expect(mocks.installations).toHaveBeenCalledWith("ghu_person_token", { fetchImpl: undefined });
    expect(mocks.save).toHaveBeenCalledWith({ orgId: ORG, connectedBy: USER, installation: INSTALLATION });
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?github=connected#github`);
    expect(response.headers.get("set-cookie")).toMatch(/vx_github_install=;.*Max-Age=0/i);
    // The person's token is used for that one check, and kept nowhere.
    expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("ghu_person_token");
  });

  it("saves nothing for an installation GitHub does not list as the person's: an installation_id alone is never trusted (Review focus 1)", async () => {
    mocks.installations.mockResolvedValue([{ ...INSTALLATION, id: 7 }]);
    const { state, cookie } = started();
    const response = await finish(callback({ state, code: "code-1", installation_id: "42", setup_action: "install" }, cookie));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?github=not_yours#github`);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a state that is not Vestiarion's, has expired, or was started in another browser, with no redirect", async () => {
    const { state, cookie } = started();
    for (const request of [
      callback({ state: `${state}x`, code: "c", installation_id: "42" }, cookie),
      callback({ state, code: "c", installation_id: "42" }, "vx_github_install=" + "m".repeat(43)),
      callback({ state, code: "c", installation_id: "42" }),
      callback({ state: started(USER, Date.now() - 11 * 60_000).state, code: "c", installation_id: "42" }, cookie),
    ]) {
      const response = await finish(request);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Start again from Settings");
    }
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers forbidden to another person signed in, or to someone who can no longer manage integrations", async () => {
    const other = started(OTHER_USER);
    expect(location(await finish(callback({ state: other.state, code: "c", installation_id: "42" }, other.cookie))).searchParams.get("github")).toBe("forbidden");

    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "viewer" });
    const mine = started();
    expect(location(await finish(callback({ state: mine.state, code: "c", installation_id: "42" }, mine.cookie))).searchParams.get("github")).toBe("forbidden");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("says cancelled without a code or an installation, and requested when an owner of the account must approve the app first", async () => {
    const { state, cookie } = started();
    expect(location(await finish(callback({ state, installation_id: "42" }, cookie))).searchParams.get("github")).toBe("cancelled");
    expect(location(await finish(callback({ state, code: "c" }, cookie))).searchParams.get("github")).toBe("cancelled");
    expect(location(await finish(callback({ state, code: "c", setup_action: "request" }, cookie))).searchParams.get("github")).toBe("requested");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("says failed when GitHub refuses the code or cannot be reached, and saves nothing", async () => {
    const { state, cookie } = started();
    mocks.exchange.mockResolvedValueOnce(null);
    expect(location(await finish(callback({ state, code: "c", installation_id: "42" }, cookie))).searchParams.get("github")).toBe("failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.installations.mockRejectedValueOnce(new Error("GitHub answered HTTP 502 to an installations list"));
    expect(location(await finish(callback({ state, code: "c", installation_id: "42" }, cookie))).searchParams.get("github")).toBe("failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("ghu_person_token");
    log.mockRestore();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
