import { describe, expect, it } from "vitest";
import { ConfigError, configFromEnv, describeConfig } from "@/lib/config";

const minimal = {
  NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

const env = (over: Record<string, string | undefined> = {}) =>
  ({ ...minimal, ...over });

describe("configFromEnv — the database is the one hard requirement", () => {
  it("builds a usable config from just a database", () => {
    const config = configFromEnv(env());
    expect(config.database).toEqual({ url: "https://proj.supabase.co", serviceRoleKey: "service-role" });
    expect(config.llm).toEqual({});
  });

  it("refuses to build without a database, rather than failing later", () => {
    expect(() => configFromEnv({})).toThrow(ConfigError);
    expect(() => configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "x" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("treats blank and whitespace-only values as absent", () => {
    // "" and "   " in a .env file are the most common way a variable looks set
    // and is not. Reading them as configured produces a confusing failure a
    // long way from the cause.
    expect(() => configFromEnv(env({ SUPABASE_SERVICE_ROLE_KEY: "   " }))).toThrow(ConfigError);
    expect(configFromEnv(env({ GITHUB_TOKEN: "" })).githubToken).toBeUndefined();
    expect(configFromEnv(env({ BUSINESS_NAME: "  " })).businessName).toBe("Vestiarion workspace");
  });
});

describe("configFromEnv — LLM selection", () => {
  it("collects every provider whose key is present", () => {
    const config = configFromEnv(env({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      OPENAI_BASE_URL: "https://proxy.example",
      DEEPSEEK_API_KEY: "d",
      DEEPSEEK_MODEL: "deepseek-chat",
    }));
    expect(config.llm.anthropic).toEqual({ apiKey: "a", model: undefined });
    expect(config.llm.openai).toMatchObject({ apiKey: "o", baseUrl: "https://proxy.example" });
    expect(config.llm.deepseek).toMatchObject({ apiKey: "d", model: "deepseek-chat" });
    expect(config.llm.provider).toBeUndefined();
  });

  it("refuses a pinned provider whose key is missing", () => {
    // The dangerous behaviour is quietly spending through whichever key does
    // happen to be present.
    expect(() =>
      configFromEnv(env({ ANTHROPIC_API_KEY: "a", AGENT_LLM_PROVIDER: "openai" }))
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("refuses an unrecognised provider name rather than auto-selecting", () => {
    expect(() =>
      configFromEnv(env({ DEEPSEEK_API_KEY: "d", AGENT_LLM_PROVIDER: "llama" }))
    ).toThrow(/not one of/);
  });

  it("accepts a pinned provider case-insensitively", () => {
    expect(configFromEnv(env({ DEEPSEEK_API_KEY: "d", AGENT_LLM_PROVIDER: "DeepSeek" })).llm.provider)
      .toBe("deepseek");
  });

  it("lets the heuristic be pinned with no keys at all", () => {
    expect(configFromEnv(env({ AGENT_LLM_PROVIDER: "heuristic" })).llm.provider).toBe("heuristic");
  });
});

describe("configFromEnv — defaults that encode a policy", () => {
  it("re-screens every cycle on the bundled list and daily on a live one", () => {
    // The bundled list costs nothing, so it runs every cycle. A live provider
    // is a network call per counterparty, so it does not.
    expect(configFromEnv(env()).compliance.rescreenIntervalHours).toBe(0);
    expect(
      configFromEnv(env({ OPENSANCTIONS_API_URL: "http://yente:8000" })).compliance.rescreenIntervalHours
    ).toBe(24);
  });

  it("honours an explicit screening interval over either default", () => {
    expect(configFromEnv(env({ COMPLIANCE_RESCREEN_HOURS: "6" })).compliance.rescreenIntervalHours).toBe(6);
    expect(
      configFromEnv(env({ OPENSANCTIONS_API_URL: "http://y", COMPLIANCE_RESCREEN_HOURS: "0" }))
        .compliance.rescreenIntervalHours
    ).toBe(0);
  });

  it("falls back to screening more often, never less, on a bad value", () => {
    for (const bad of ["abc", "-5", ""]) {
      expect(configFromEnv(env({ COMPLIANCE_RESCREEN_HOURS: bad })).compliance.rescreenIntervalHours).toBe(0);
    }
  });

  it("keeps follow-up escalation on a sane cadence when misconfigured", () => {
    // A bad value must not mean "stay silent forever", which is the direction
    // that loses money quietly.
    for (const bad of ["abc", "-1", "0"]) {
      expect(configFromEnv(env({ FOLLOW_UP_STALE_DAYS: bad })).followUp.staleAfterDays).toBe(3);
    }
    expect(configFromEnv(env({ FOLLOW_UP_STALE_DAYS: "1.5" })).followUp.staleAfterDays).toBe(1.5);
  });

  it("keeps the demo clock outside production, and the wall clock inside it", () => {
    // Preserves exactly what `cycleClockMode` did before the decision moved
    // here. Defaulting to "real" would quietly have changed how the demo
    // behaves for everyone running locally.
    expect(configFromEnv(env()).clockMode).toBe("simulate");
    expect(configFromEnv(env({ NODE_ENV: "production" })).clockMode).toBe("real");
    expect(configFromEnv(env({ CYCLE_CLOCK_MODE: "real" })).clockMode).toBe("real");
    expect(
      configFromEnv(env({ NODE_ENV: "production", CYCLE_CLOCK_MODE: "simulate" })).clockMode
    ).toBe("simulate");
    expect(configFromEnv(env({ CYCLE_CLOCK_MODE: "anything-else" })).clockMode).toBe("simulate");
  });
});

describe("describeConfig", () => {
  const full = () =>
    configFromEnv(env({
      BUSINESS_NAME: "Northstar Studio",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      DEEPSEEK_API_KEY: "sk-deep-secret",
      CIRCLE_API_KEY: "circle-secret",
      CIRCLE_ENTITY_SECRET: "entity-secret",
      OPENSANCTIONS_API_URL: "http://yente:8000",
      OPENSANCTIONS_API_KEY: "os-secret",
      GITHUB_TOKEN: "ghp-secret",
      LEDGER_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----",
    }));

  it("leaks no secret anywhere in its output", () => {
    // This object goes into logs and responses. One accidental passthrough
    // would publish a service-role key.
    const json = JSON.stringify(describeConfig(full()));
    for (const secret of [
      "sk-ant-secret", "sk-deep-secret", "circle-secret", "entity-secret",
      "os-secret", "ghp-secret", "service-role", "BEGIN PRIVATE KEY",
    ]) {
      expect(json, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("still says what is configured", () => {
    const described = describeConfig(full());
    expect(described).toMatchObject({
      businessName: "Northstar Studio",
      ledgerSigningKeyProvided: true,
      githubTokenProvided: true,
    });
    expect(described.llm).toEqual({ pinned: null, available: ["anthropic", "deepseek"] });
    expect(described.compliance).toMatchObject({ mode: "live" });
    expect(described.chain).toEqual({ circleConfigured: true, arcRpcConfigured: false });
  });

  it("says whether a public key is configured, separately from the signing key", () => {
    // An operator reading /api/v1/status needs to know whether this deployment
    // can check signatures at all. A verify-only host holds the public half and
    // no signing key, so one flag cannot answer for both.
    expect(describeConfig(full())).toMatchObject({ ledgerPublicKeyProvided: false });
    expect(
      describeConfig(configFromEnv(env({ LEDGER_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----" })))
    ).toMatchObject({ ledgerPublicKeyProvided: true, ledgerSigningKeyProvided: false });
  });

  it("reports the database by host only", () => {
    expect(describeConfig(full()).database).toEqual({ host: "proj.supabase.co" });
  });

  it("does not throw on a malformed database url", () => {
    const config = configFromEnv(env({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" }));
    expect(describeConfig(config).database).toEqual({ host: "invalid-url" });
  });
});
