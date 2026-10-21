import { afterEach, describe, expect, it, vi } from "vitest";
import { screenName } from "@/lib/compliance";
import { ConfigError, configFromEnv, screeningSettingsFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { buildEvidenceChain } from "@/lib/evidence-chain";
import { checkScreening } from "@/lib/screening/check";
import { OPENSANCTIONS_API_URL, providerOfSource, screeningProvider } from "@/lib/screening/providers";
import { screeningSourceLabel } from "@/lib/screening-source";
import { paidInFull } from "./support/evidence-fixtures";

/**
 * Screening providers (docs/superpowers/specs/2026-10-21-screening-providers-design.md SP1-SP5): the deployment names
 * the service that screens names, OpenSanctions' hosted API or a self-hosted yente server, by its environment; both
 * speak yente's match API, each verdict records which one gave it, and a key is checked before it is set.
 */

const SUPABASE = { NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
const KEY = "sk-test-screening-0f3a9c";

type Candidate = { id: string; caption: string; score: number; topics: string[] };

function answer(results: Candidate[], status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        responses: {
          counterparty: { status, results: results.map((r) => ({ id: r.id, caption: r.caption, score: r.score, target: true, properties: { topics: r.topics } })) },
        },
      }),
      { status: 200 }
    )
  );
}

const SANCTIONED: Candidate = { id: "NK-zenith", caption: "Zenith Trading LLC", score: 0.94, topics: ["sanction"] };
const PEP: Candidate = { id: "Q-pep", caption: "A Minister", score: 0.81, topics: ["role.pep"] };

afterEach(() => vi.unstubAllGlobals());

describe("which provider the environment names (SP3)", () => {
  it("screens with nothing when nothing is set", () => {
    expect(screeningSettingsFromEnv({})).toEqual({});
  });

  it("reads the old variables as OpenSanctions, as before", () => {
    expect(screeningSettingsFromEnv({ OPENSANCTIONS_API_URL: "https://yente.internal", OPENSANCTIONS_API_KEY: KEY })).toEqual({
      provider: "opensanctions",
      url: "https://yente.internal",
      apiKey: KEY,
    });
    expect(screeningSettingsFromEnv({ OPENSANCTIONS_API_URL: "https://yente.internal" })).toEqual({ provider: "opensanctions", url: "https://yente.internal" });
  });

  it("reads the new ones alone, never mixed with the old", () => {
    expect(
      screeningSettingsFromEnv({
        SCREENING_PROVIDER: "yente",
        SCREENING_API_URL: "https://yente.example.org",
        SCREENING_API_KEY: KEY,
        OPENSANCTIONS_API_URL: "https://old.example.org",
        OPENSANCTIONS_API_KEY: "old-key",
      })
    ).toEqual({ provider: "yente", url: "https://yente.example.org", apiKey: KEY });
  });

  it("never sends the old key to the new address, nor screens the old address as the new provider", () => {
    expect(
      screeningSettingsFromEnv({ SCREENING_PROVIDER: "yente", SCREENING_API_URL: "https://yente.example.org", OPENSANCTIONS_API_KEY: "paid-opensanctions-key" })
    ).toEqual({ provider: "yente", url: "https://yente.example.org" });
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "yente", OPENSANCTIONS_API_URL: "https://api.opensanctions.org" })).toThrow("SCREENING_API_URL");
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "opensanctions", OPENSANCTIONS_API_KEY: KEY })).toThrow("no SCREENING_API_KEY");
  });

  it("refuses an address or key with no provider, and an address that is not http(s)", () => {
    expect(() => screeningSettingsFromEnv({ SCREENING_API_URL: "https://yente.example.org" })).toThrow("without SCREENING_PROVIDER");
    expect(() => screeningSettingsFromEnv({ SCREENING_API_KEY: KEY, OPENSANCTIONS_API_URL: "https://yente.internal" })).toThrow("without SCREENING_PROVIDER");
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "yente", SCREENING_API_URL: "yente.internal" })).toThrow("not an http(s) address");
  });

  it("reaches OpenSanctions' hosted API when only its key is given", () => {
    expect(screeningSettingsFromEnv({ SCREENING_PROVIDER: "OpenSanctions", SCREENING_API_KEY: KEY })).toEqual({
      provider: "opensanctions",
      url: OPENSANCTIONS_API_URL,
      apiKey: KEY,
    });
    expect(OPENSANCTIONS_API_URL).toBe("https://api.opensanctions.org");
  });

  it("refuses a provider named without what it needs, or one it does not know, naming the variable", () => {
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "opensanctions" })).toThrow(ConfigError);
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "opensanctions" })).toThrow("SCREENING_API_KEY");
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "yente", SCREENING_API_KEY: KEY })).toThrow("SCREENING_API_URL");
    expect(() => screeningSettingsFromEnv({ SCREENING_PROVIDER: "dowjones", SCREENING_API_KEY: KEY })).toThrow("is not one of opensanctions, yente");
  });

  it("refuses them at start, as the deployment's configuration", () => {
    expect(() => configFromEnv({ ...SUPABASE, SCREENING_PROVIDER: "yente" })).toThrow(ConfigError);
    const config = configFromEnv({ ...SUPABASE, SCREENING_PROVIDER: "yente", SCREENING_API_URL: "https://yente.example.org" });
    expect(config.compliance).toMatchObject({ openSanctionsUrl: "https://yente.example.org", screeningProvider: "yente" });
    expect(config.compliance).not.toHaveProperty("openSanctionsApiKey");
  });
});

describe("both providers ask yente's match API (SP1, SP2)", () => {
  it("OpenSanctions: its address, its key, its source", async () => {
    const fetchMock = answer([SANCTIONED]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await screeningProvider("opensanctions", { url: OPENSANCTIONS_API_URL, apiKey: KEY }).screen("Zenith Trading LLC", "ae", new Set());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.opensanctions.org/match/default?limit=25");
    expect(init.headers).toMatchObject({ Authorization: `ApiKey ${KEY}` });
    expect(JSON.parse(String(init.body))).toMatchObject({ queries: { counterparty: { schema: "LegalEntity", properties: { name: ["Zenith Trading LLC"], jurisdiction: ["ae"] } } } });
    expect(result).toMatchObject({ riskLevel: "high", source: "opensanctions:yente", screeningMode: "live", rawScore: 0.94, matchedEntityId: "NK-zenith" });
  });

  it("a yente server: the address it is given, no key unless it asks for one, its own source", async () => {
    const fetchMock = answer([PEP]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await screeningProvider("yente", { url: "https://yente.example.org/" }).screen("A Minister", null, new Set());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://yente.example.org/match/default?limit=25");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(init.body)).queries.counterparty.properties).not.toHaveProperty("jurisdiction");
    expect(result).toMatchObject({ riskLevel: "medium", source: "yente:self-hosted", matchedTopics: ["role.pep"] });
  });

  it("keeps a full match endpoint as it is given", async () => {
    const fetchMock = answer([]);
    vi.stubGlobal("fetch", fetchMock);
    await screeningProvider("yente", { url: "https://yente.example.org/match/sanctions" }).screen("Acme", null, new Set());
    expect(fetchMock.mock.calls[0][0]).toBe("https://yente.example.org/match/sanctions?limit=25");
  });

  it("names itself when nothing matched", async () => {
    vi.stubGlobal("fetch", answer([]));
    expect(await screeningProvider("yente", { url: "https://yente.example.org" }).screen("Acme", null, new Set())).toMatchObject({
      riskLevel: "clear",
      notes: "a yente server returned no matching entity",
      source: "yente:self-hosted",
    });
    vi.stubGlobal("fetch", answer([]));
    expect((await screeningProvider("opensanctions", { url: OPENSANCTIONS_API_URL, apiKey: KEY }).screen("Acme", null, new Set())).notes).toBe(
      "OpenSanctions returned no matching entity"
    );
  });

  it("skips a match a person dismissed, and asks for it on top of twenty-five", async () => {
    const fetchMock = answer([SANCTIONED, PEP]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await screeningProvider("yente", { url: "https://yente.example.org" }).screen("Zenith Trading LLC", null, new Set(["NK-zenith"]));

    expect(fetchMock.mock.calls[0][0]).toBe("https://yente.example.org/match/default?limit=26");
    expect(result).toMatchObject({ riskLevel: "medium", matchedEntityId: "Q-pep" });
    expect(result.matches?.map((match) => match.id)).toEqual(["Q-pep"]);
  });

  it("fails, never clears, when the provider does not answer or answers nonsense", async () => {
    const provider = screeningProvider("yente", { url: "https://yente.example.org" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(provider.screen("Acme", null, new Set())).rejects.toThrow("a yente server screening failed with HTTP 503");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ hello: "world" }), { status: 200 })));
    await expect(provider.screen("Acme", null, new Set())).rejects.toThrow("a yente server returned an invalid match response");
    vi.stubGlobal("fetch", answer([], 500));
    await expect(provider.screen("Acme", null, new Set())).rejects.toThrow("a yente server query failed with status 500");
  });
});

describe("screenName through the deployment's provider", () => {
  it("screens with a yente server when the deployment names one", async () => {
    const fetchMock = answer([SANCTIONED]);
    vi.stubGlobal("fetch", fetchMock);
    const config = configFromEnv({ ...SUPABASE, SCREENING_PROVIDER: "yente", SCREENING_API_URL: "https://yente.example.org" });

    const result = await runWithConfig(config, () => screenName("Zenith Trading LLC"));

    expect(fetchMock.mock.calls[0][0]).toBe("https://yente.example.org/match/default?limit=25");
    expect(result).toMatchObject({ riskLevel: "high", source: "yente:self-hosted" });
  });

  it("still screens a sandbox against the bundled list, and a live workspace with no provider not at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plain = configFromEnv(SUPABASE);
    expect((await runWithConfig(plain, () => screenName("Zenith Trading LLC"))).source).not.toMatch(/yente/);
    await expect(runWithConfig({ ...plain, compliance: { ...plain.compliance, serviceRequired: true } }, () => screenName("Acme"))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the console and the evidence name the provider (SP4)", () => {
  it("names a yente server in the console", () => {
    const config = configFromEnv({ ...SUPABASE, SCREENING_PROVIDER: "yente", SCREENING_API_URL: "https://yente.example.org" });
    expect(runWithConfig(config, () => screeningSourceLabel())).toBe("a yente server");
    expect(runWithConfig(configFromEnv({ ...SUPABASE, SCREENING_PROVIDER: "opensanctions", SCREENING_API_KEY: KEY }), () => screeningSourceLabel())).toBe("OpenSanctions");
  });

  it("reads a verdict's provider from its source", () => {
    expect(providerOfSource("opensanctions:yente")).toBe("opensanctions");
    expect(providerOfSource("yente:self-hosted")).toBe("yente");
    expect(providerOfSource("bundled-list")).toBeNull();
    expect(providerOfSource("ofac-sdn")).toBeNull();
  });

  it("says which provider screened the payee in the evidence chain", () => {
    const base = paidInFull();
    const screened = (source: string) =>
      buildEvidenceChain({ ...base, screening: { ...base.screening!, source } }).steps.find((step) => step.id === "payee")?.facts.at(-1);
    expect(screened("yente:self-hosted")).toMatchObject({ kind: "verified", text: expect.stringMatching(/was screened clear by a yente server\.$/) });
    expect(screened("opensanctions:yente")).toMatchObject({ kind: "verified", text: expect.stringMatching(/was screened clear by OpenSanctions\.$/) });
  });
});

describe("checking a key before it is set (SP5)", () => {
  const clock = () => {
    let t = 1_000;
    return () => (t += 120);
  };

  it("prints the verdict, the best matches and the time, the address's origin, and never the key", async () => {
    vi.stubGlobal("fetch", answer([SANCTIONED, PEP]));

    const { ok, lines } = await checkScreening(
      { SCREENING_PROVIDER: "opensanctions", SCREENING_API_URL: "https://api.opensanctions.org/match/default", SCREENING_API_KEY: KEY },
      "Zenith Trading LLC",
      clock()
    );

    expect(ok).toBe(true);
    expect(lines[0]).toBe("Provider: OpenSanctions at https://api.opensanctions.org, with a key");
    expect(lines[1]).toBe('Screened "Zenith Trading LLC" in 120 ms: high. Zenith Trading LLC matched at 0.940 (sanction)');
    expect(lines.slice(2)).toEqual(["  Zenith Trading LLC, 0.94 (sanction)", "  A Minister, 0.81 (role.pep)"]);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("/match/default");
  });

  it("says what is missing, and why it failed, still without the key", async () => {
    expect(await checkScreening({}, "Acme")).toMatchObject({ ok: false, lines: [expect.stringContaining("No screening provider is configured")] });
    expect(await checkScreening({ SCREENING_PROVIDER: "yente" }, "Acme")).toMatchObject({ ok: false, lines: [expect.stringContaining("SCREENING_API_URL")] });
    // An old address that is not a URL: said plainly, and none of it printed.
    const malformed = await checkScreening({ OPENSANCTIONS_API_URL: "yente.internal?api_key=FAKE-SECRET-123" }, "Acme");
    expect(malformed).toEqual({ ok: false, lines: ["The address for OpenSanctions is not a URL: give it as https://host or https://host/match/<dataset>."] });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
    const failed = await checkScreening({ SCREENING_PROVIDER: "opensanctions", SCREENING_API_KEY: KEY }, "Acme", clock());
    expect(failed.ok).toBe(false);
    expect(failed.lines.at(-1)).toBe("Screening failed after 120 ms: OpenSanctions screening failed with HTTP 403");
    expect(failed.lines.join("\n")).not.toContain(KEY);
  });
});
