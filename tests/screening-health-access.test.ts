import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The team's screening page (/admin/screening, docs/superpowers/specs/2026-10-22-screening-health-design.md SH1, SH3):
 * a signed-in person on platform_team, as on the founder dashboard. Anyone else gets notFound from the page, and Check
 * now refuses them before calling anyone. For the team, Check now makes one lookup with the deployment's provider and
 * writes nothing: no counterparty, no compliance check, no ledger entry, only one log line, never with the key or the
 * full address.
 */

vi.mock("server-only", () => ({}));

const KEY = "sk-live-screening-c0ffee";
const URL_SECRET = "url-secret-5e1f";
const SELF_HOSTED = `https://yente.example.org/match/default?api_key=${URL_SECRET}`;

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string | null } | null,
  teamMember: false,
  gateFails: false,
  healthFails: false,
  health: null as unknown,
  calls: [] as Array<{ kind: "rpc" | "from"; name: string }>,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  }),
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn(async () => state.user) }));
// The only database the page and the action can reach: every call is recorded, and any table read or write fails.
vi.mock("@/lib/dal", () => ({
  platformDb: () => ({
    rpc: async (name: string) => {
      state.calls.push({ kind: "rpc", name });
      if (name === "growth_team_member") return state.gateFails ? { data: null, error: { message: "function does not exist" } } : { data: state.teamMember, error: null };
      if (name === "screening_health") return state.healthFails ? { data: null, error: { message: "function public.screening_health() does not exist" } } : { data: state.health, error: null };
      return { data: null, error: { message: `${name} is not called in this test` } };
    },
    from: (table: string) => {
      state.calls.push({ kind: "from", name: table });
      throw new Error(`${table} is not read in this test`);
    },
  }),
  db: () => {
    throw new Error("no workspace's database is reached from the team's page");
  },
}));

import { checkScreeningNowAction } from "@/app/admin/screening/actions";
import ScreeningHealthPage, { metadata } from "@/app/admin/screening/page";
import sitemap from "@/app/sitemap";
import { requiresSession } from "@/lib/auth/routes";

const TEAM = { id: "11111111-1111-4111-8111-111111111111", email: "team@vestiarion.test" };
const CUSTOMER = { id: "22222222-2222-4222-8222-222222222222", email: "owner@customer.test" };

const HEALTH = {
  lastComplete: { at: "2026-10-22T11:40:00+00:00", slug: "base-payout-test", source: "opensanctions:yente" },
  lastFailed: { at: "2026-10-03T09:12:00+00:00", slug: "pinecrest-studio", source: "opensanctions:yente", note: `OpenSanctions screening failed with HTTP 429 ${KEY}` },
  day: { complete: 3, failed: 0 },
  week: { complete: 12, failed: 1 },
};

const render = async () => renderToStaticMarkup(await ScreeningHealthPage());

function useEnv(env: Record<string, string>) {
  for (const name of ["SCREENING_PROVIDER", "SCREENING_API_URL", "SCREENING_API_KEY", "OPENSANCTIONS_API_URL", "OPENSANCTIONS_API_KEY"]) vi.stubEnv(name, env[name] ?? "");
}

let fetchMock: ReturnType<typeof vi.fn>;
let info: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.user = null;
  state.teamMember = false;
  state.gateFails = false;
  state.healthFails = false;
  state.health = HEALTH;
  state.calls = [];
  useEnv({ OPENSANCTIONS_API_URL: "https://api.opensanctions.org", OPENSANCTIONS_API_KEY: KEY });
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ responses: { counterparty: { status: 200, results: [] } } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const asTeam = () => {
  state.user = TEAM;
  state.teamMember = true;
};

describe("the team's screening page: its gate", () => {
  it("is notFound for an anonymous visitor, without asking the database", async () => {
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(state.calls).toEqual([]);
  });

  it("is notFound for a signed-in person off the team, having asked only the gate", async () => {
    state.user = CUSTOMER;
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(state.calls).toEqual([{ kind: "rpc", name: "growth_team_member" }]);
  });

  it("fails closed when the gate cannot be read", async () => {
    state.user = TEAM;
    state.gateFails = true;
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it.each([
    ["an anonymous visitor", null],
    ["a signed-in person off the team", CUSTOMER],
  ])("refuses Check now to %s, calling no provider", async (_who, user) => {
    state.user = user;
    expect(await checkScreeningNowAction()).toEqual({ ok: false, message: "This is not available." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(state.calls.filter((call) => call.name !== "growth_team_member")).toEqual([]);
  });

  it("is out of the sitemap, asks not to be indexed, and needs no login redirect that would reveal it", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some((entry) => entry.url.includes("/admin"))).toBe(false);
    expect(requiresSession("/admin/screening")).toBe(false);
  });
});

describe("Check now, for the team (SH1)", () => {
  it("screens the fixed fictitious name once with the deployment's provider, and answers in this shape", async () => {
    asTeam();
    const result = await checkScreeningNowAction();
    expect(result).toEqual({
      ok: true,
      message: expect.stringMatching(/^OpenSanctions answered in \d+ ms: the key works\.$/),
      check: {
        name: "Zenith Trading Example LLC",
        provider: "OpenSanctions",
        origin: "https://api.opensanctions.org",
        keySet: true,
        variableSet: "OPENSANCTIONS_*",
        result: "OK",
        httpStatus: null,
        ms: expect.any(Number),
        verdict: "clear: OpenSanctions returned no matching entity",
        checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.opensanctions.org/match/default?limit=25");
    expect(JSON.parse(String(init.body))).toEqual({ queries: { counterparty: { schema: "LegalEntity", properties: { name: ["Zenith Trading Example LLC"] } } } });
  });

  it("writes nothing: no table, no function but the gate, no workspace; one log line", async () => {
    asTeam();
    await checkScreeningNowAction();
    expect(state.calls).toEqual([{ kind: "rpc", name: "growth_team_member" }]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([expect.stringMatching(/^screening check: provider=opensanctions origin=https:\/\/api\.opensanctions\.org ok=true status=2xx ms=\d+$/)]);
  });

  it("says a refused key by its status", async () => {
    asTeam();
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const result = await checkScreeningNowAction();
    expect(result).toMatchObject({ ok: false, message: "OpenSanctions gave no verdict: HTTP 401: the key is refused.", check: { result: "HTTP 401: the key is refused", httpStatus: 401, verdict: null } });
    expect(info.mock.calls[0][0]).toMatch(/ ok=false status=401 ms=\d+$/);
  });

  it("never returns or logs the key or the full address, even when the provider's error quotes them", async () => {
    asTeam();
    useEnv({ SCREENING_PROVIDER: "yente", SCREENING_API_URL: SELF_HOSTED, SCREENING_API_KEY: KEY });
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${SELF_HOSTED}&limit=25 with ApiKey ${KEY}`));
    const result = await checkScreeningNowAction();
    expect(result).toMatchObject({ ok: false, check: { provider: "a yente server", origin: "https://yente.example.org", variableSet: "SCREENING_*", result: "Failed: fetch failed for https://yente.example.org with ApiKey [redacted]" } });
    const everything = JSON.stringify([result, info.mock.calls, errors.mock.calls]);
    for (const secret of [KEY, URL_SECRET, "/match/default", SELF_HOSTED]) expect(everything).not.toContain(secret);
  });

  it("makes no lookup when the settings stop the app at start, and says so", async () => {
    asTeam();
    useEnv({ SCREENING_API_KEY: KEY, OPENSANCTIONS_API_URL: "https://api.opensanctions.org", OPENSANCTIONS_API_KEY: KEY });
    const result = await checkScreeningNowAction();
    expect(result).toMatchObject({
      ok: false,
      message: "No lookup was made: the screening settings are not usable.",
      check: { variableSet: "SCREENING_*", provider: null, result: "SCREENING_API_URL or SCREENING_API_KEY is set without SCREENING_PROVIDER: name opensanctions or yente." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the page, for the team (SH1, SH3)", () => {
  it("shows the setup and live checks across workspaces, calling no provider and showing no key", async () => {
    asTeam();
    const markup = await render();
    expect(markup).toContain("Screening");
    expect(markup).toContain("Team only");
    expect(markup).toContain("OpenSanctions");
    expect(markup).toContain("https://api.opensanctions.org");
    expect(markup).toContain("OPENSANCTIONS_*");
    expect(markup).toContain("Check now");
    expect(markup).toContain("Oct 22, 2026, 11:40 UTC");
    expect(markup).toContain("base-payout-test · opensanctions:yente");
    expect(markup).toContain("pinecrest-studio: OpenSanctions screening failed with HTTP 429 [redacted] (over quota)");
    expect(markup).toContain("3 complete · 0 failed");
    expect(markup).toContain("12 complete · 1 failed");
    expect(markup).not.toContain(KEY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.calls).toEqual([
      { kind: "rpc", name: "growth_team_member" },
      { kind: "rpc", name: "screening_health" },
    ]);
  });

  it("says the platform read is not there yet before migration 0139, and still offers Check now", async () => {
    asTeam();
    state.healthFails = true;
    const markup = await render();
    expect(markup).toContain("The platform read is not there yet");
    expect(markup).toContain("Check now");
  });

  it("says why no lookup can be made when the settings are not usable", async () => {
    asTeam();
    useEnv({ SCREENING_PROVIDER: "yente" });
    const markup = await render();
    expect(markup).toContain("No lookup can be made");
    expect(markup).toContain("SCREENING_PROVIDER=yente but no SCREENING_API_URL is set");
  });
});

describe("the platform-wide read (SH3)", () => {
  const SRC = path.join(process.cwd(), "src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => (statSync(path.join(dir, entry)).isDirectory() ? walk(path.join(dir, entry)) : [path.join(dir, entry)]));

  it("is used on the team's page only", () => {
    const users = walk(SRC)
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(path.join("screening", "platform-health.ts")))
      .filter((file) => /screening\/platform-health["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"));
    expect(users).toEqual(["src/app/admin/screening/page.tsx"]);
  });
});
