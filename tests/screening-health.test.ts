import { afterEach, describe, expect, it, vi } from "vitest";
import { screeningVariableSet } from "@/lib/config";
import { checkScreening, redactForEnv, redactScreeningSecrets, runScreeningCheck, screeningCheckLogLine, screeningCheckView, screeningSetup } from "@/lib/screening/check";
import { failureKindOfNote, ScreeningHttpError, screeningFailureKind, screeningHttpFailure, screeningProvider } from "@/lib/screening/providers";

/**
 * Screening health (docs/superpowers/specs/2026-10-22-screening-health-design.md SH1, SH2): a provider's HTTP failure is
 * typed by its status, with the message it always had, and one check of the deployment's key comes back structured for
 * the team's page and its one log line, never with the key or more of the address than its origin.
 */

const KEY = "sk-live-screening-7d41e0";
const URL_SECRET = "url-secret-93ab";
const SELF_HOSTED = `https://yente.example.org/match/default?api_key=${URL_SECRET}`;

const clock = () => {
  let t = 1_000;
  return () => (t += 250);
};

function answered(results: Array<{ id: string; caption: string; score: number; topics: string[] }> = []) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ responses: { counterparty: { status: 200, results: results.map((r) => ({ ...r, target: true, properties: { topics: r.topics } })) } } }),
      { status: 200 }
    )
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a provider's HTTP failure, typed (SH2)", () => {
  it.each([
    [401, "key_refused"],
    [403, "key_refused"],
    [429, "over_quota"],
    [500, "provider_down"],
    [503, "provider_down"],
    [404, "other"],
  ] as const)("HTTP %i is %s, with the message it always had", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status })));
    const failure = await screeningProvider("opensanctions", { url: "https://api.opensanctions.org", apiKey: KEY })
      .screen("Acme", null, new Set())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScreeningHttpError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ status, kind, message: `OpenSanctions screening failed with HTTP ${status}` });
    expect(screeningFailureKind(status)).toBe(kind);
  });

  it("names a yente server in its message as before", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 502 })));
    await expect(screeningProvider("yente", { url: "https://yente.example.org" }).screen("Acme", null, new Set())).rejects.toThrow(
      new ScreeningHttpError("a yente server", 502)
    );
  });

  it("is found behind a wrapper that keeps it as its cause, and only an HTTP failure is", () => {
    const http = new ScreeningHttpError("OpenSanctions", 401);
    expect(screeningHttpFailure(http)).toBe(http);
    expect(screeningHttpFailure(new Error(http.message, { cause: http }))).toBe(http);
    expect(screeningHttpFailure(new Error("OpenSanctions returned an invalid match response"))).toBeNull();
    expect(screeningHttpFailure("HTTP 401")).toBeNull();
  });

  it("is read back from a failed check's note by its status", () => {
    expect(failureKindOfNote("OpenSanctions screening failed with HTTP 401")).toBe("key_refused");
    expect(failureKindOfNote("OpenSanctions screening failed with HTTP 429")).toBe("over_quota");
    expect(failureKindOfNote("Invalid URL")).toBeNull();
    expect(failureKindOfNote("a yente server query failed with status 500")).toBeNull();
  });
});

describe("which variables are in use (SH1)", () => {
  it("is the new set as soon as one of its names is set, else the old pair, else none", () => {
    expect(screeningVariableSet({})).toBeNull();
    expect(screeningVariableSet({ OPENSANCTIONS_API_URL: "https://api.opensanctions.org", OPENSANCTIONS_API_KEY: KEY })).toBe("OPENSANCTIONS_*");
    expect(screeningVariableSet({ OPENSANCTIONS_API_KEY: KEY })).toBe("OPENSANCTIONS_*");
    expect(screeningVariableSet({ SCREENING_API_KEY: KEY, OPENSANCTIONS_API_URL: "https://api.opensanctions.org" })).toBe("SCREENING_*");
    expect(screeningVariableSet({ SCREENING_PROVIDER: "  ", OPENSANCTIONS_API_URL: "https://api.opensanctions.org" })).toBe("OPENSANCTIONS_*");
  });

  it("is read with the setup, without calling the provider", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(screeningSetup({ OPENSANCTIONS_API_URL: "https://api.opensanctions.org", OPENSANCTIONS_API_KEY: KEY })).toEqual({
      variableSet: "OPENSANCTIONS_*",
      provider: "opensanctions",
      label: "OpenSanctions",
      origin: "https://api.opensanctions.org",
      keySet: true,
      problem: null,
    });
    // A key with no provider stops the app at start: said, with the key's presence and none of its value.
    expect(screeningSetup({ SCREENING_API_KEY: KEY, OPENSANCTIONS_API_URL: "https://api.opensanctions.org" })).toEqual({
      variableSet: "SCREENING_*",
      provider: null,
      label: null,
      origin: null,
      keySet: true,
      problem: "SCREENING_API_URL or SCREENING_API_KEY is set without SCREENING_PROVIDER: name opensanctions or yente.",
    });
    expect(screeningSetup({})).toMatchObject({ variableSet: null, provider: null, keySet: false, problem: expect.stringContaining("No screening provider is configured") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("one check, structured (SH1)", () => {
  it("gives the provider, the origin, the key's presence, the variables, the time and the verdict", async () => {
    vi.stubGlobal("fetch", answered());
    const check = await runScreeningCheck({ OPENSANCTIONS_API_URL: "https://api.opensanctions.org", OPENSANCTIONS_API_KEY: KEY }, "Zenith Trading Example LLC", clock());
    expect(check).toEqual({
      variableSet: "OPENSANCTIONS_*",
      provider: "opensanctions",
      label: "OpenSanctions",
      origin: "https://api.opensanctions.org",
      keySet: true,
      problem: null,
      ok: true,
      ms: 250,
      httpStatus: null,
      failure: null,
      error: null,
      riskLevel: "clear",
      notes: "OpenSanctions returned no matching entity",
      matches: [],
    });
    expect(screeningCheckLogLine(check)).toBe("screening check: provider=opensanctions origin=https://api.opensanctions.org ok=true status=2xx ms=250");
    expect(screeningCheckView(check, "Zenith Trading Example LLC", new Date("2026-10-22T12:00:00Z"))).toEqual({
      name: "Zenith Trading Example LLC",
      provider: "OpenSanctions",
      origin: "https://api.opensanctions.org",
      keySet: true,
      variableSet: "OPENSANCTIONS_*",
      result: "OK",
      httpStatus: null,
      ms: 250,
      verdict: "clear: OpenSanctions returned no matching entity",
      checkedAt: "2026-10-22T12:00:00.000Z",
    });
  });

  it("says a refused key by its status and what it means", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const check = await runScreeningCheck({ SCREENING_PROVIDER: "opensanctions", SCREENING_API_KEY: KEY }, "Zenith Trading Example LLC", clock());
    expect(check).toMatchObject({ ok: false, variableSet: "SCREENING_*", httpStatus: 401, failure: "key_refused", error: "OpenSanctions screening failed with HTTP 401", riskLevel: null });
    expect(screeningCheckView(check, "Zenith Trading Example LLC", new Date())).toMatchObject({ result: "HTTP 401: the key is refused", verdict: null, ms: 250 });
    expect(screeningCheckLogLine(check)).toBe("screening check: provider=opensanctions origin=https://api.opensanctions.org ok=false status=401 ms=250");
  });

  it("makes no lookup when the settings are not usable, and says why", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const check = await runScreeningCheck({ SCREENING_PROVIDER: "opensanctions" }, "Zenith Trading Example LLC");
    expect(check).toMatchObject({ ok: false, ms: null, problem: "SCREENING_PROVIDER=opensanctions but no SCREENING_API_KEY is set." });
    expect(screeningCheckView(check, "Zenith Trading Example LLC", new Date()).result).toBe("SCREENING_PROVIDER=opensanctions but no SCREENING_API_KEY is set.");
    expect(screeningCheckLogLine(check)).toBe("screening check: provider=none origin=none ok=false status=none ms=none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never gives the key or the full address, even when the provider's error quotes them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${SELF_HOSTED}&limit=25 (Authorization: ApiKey ${KEY})`))
    );
    const env = { SCREENING_PROVIDER: "yente", SCREENING_API_URL: SELF_HOSTED, SCREENING_API_KEY: KEY };
    const check = await runScreeningCheck(env, "Zenith Trading Example LLC", clock());
    expect(check.error).toBe("fetch failed for https://yente.example.org (Authorization: ApiKey [redacted])");
    expect(check).toMatchObject({ ok: false, httpStatus: null, failure: null, origin: "https://yente.example.org" });
    const shown = JSON.stringify([check, screeningCheckView(check, "Zenith Trading Example LLC", new Date()), screeningCheckLogLine(check)]);
    for (const secret of [KEY, URL_SECRET, "/match/default", SELF_HOSTED]) expect(shown).not.toContain(secret);
    // The command prints the same, redacted.
    const { lines } = await checkScreening(env, "Zenith Trading Example LLC", clock());
    expect(lines.at(-1)).toBe("Screening failed after 250 ms: fetch failed for https://yente.example.org (Authorization: ApiKey [redacted])");
  });

  it("redacts every key the environment sets from text the deployment recorded", () => {
    expect(redactScreeningSecrets(`at https://user:pw@host.example/p?q=1 with ${KEY}`, { apiKey: KEY })).toBe("at https://host.example with [redacted]");
    expect(redactForEnv(`old ${KEY} new other-key`, { OPENSANCTIONS_API_KEY: KEY, SCREENING_API_KEY: "other-key" })).toBe("old [redacted] new [redacted]");
    expect(redactForEnv("OpenSanctions screening failed with HTTP 401", {})).toBe("OpenSanctions screening failed with HTTP 401");
  });
});
