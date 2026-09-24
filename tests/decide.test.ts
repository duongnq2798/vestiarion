import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decide, extractJson, selectProvider } from "@/lib/agent/decide";
import { configFromEnv, type LlmConfig } from "@/lib/config";
import { runWithConfig } from "@/lib/context";

const llm = (over: Partial<LlmConfig> = {}): LlmConfig => over;

/** A config whose only interesting part is its LLM settings. */
function configWith(llmConfig: LlmConfig) {
  return { ...configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  }), llm: llmConfig };
}

afterEach(() => vi.restoreAllMocks());

describe("selectProvider", () => {
  // A pure function of LlmConfig now. The "pinned a provider whose key is
  // missing" check moved into configFromEnv, where it fails when the config is
  // built rather than midway through a treasury cycle — see config.test.ts.
  it("falls back to the heuristic when nothing is configured", () => {
    expect(selectProvider(llm())).toBe("heuristic");
  });

  it("prefers Anthropic when several providers are available", () => {
    expect(selectProvider(llm({
      anthropic: { apiKey: "a" }, openai: { apiKey: "o" }, deepseek: { apiKey: "d" },
    }))).toBe("anthropic");
  });

  it("falls through the preference order to the one that exists", () => {
    expect(selectProvider(llm({ deepseek: { apiKey: "d" } }))).toBe("deepseek");
  });

  it("honours an explicit choice over the preference order", () => {
    expect(selectProvider(llm({
      provider: "deepseek", anthropic: { apiKey: "a" }, deepseek: { apiKey: "d" },
    }))).toBe("deepseek");
  });

  it("lets the heuristic be pinned even when providers are available", () => {
    expect(selectProvider(llm({ provider: "heuristic", anthropic: { apiKey: "a" } })))
      .toBe("heuristic");
  });

  it("reads the running scope when given no argument", () => {
    runWithConfig(configWith(llm({ deepseek: { apiKey: "d" } })), () => {
      expect(selectProvider()).toBe("deepseek");
    });
  });
});

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"action":"pay"}')).toEqual({ action: "pay" });
  });

  it("parses out of a ```json fence", () => {
    expect(extractJson('```json\n{"action":"hold"}\n```')).toEqual({ action: "hold" });
  });

  it("parses out of an unlabelled fence", () => {
    expect(extractJson('```\n{"action":"hold"}\n```')).toEqual({ action: "hold" });
  });

  it("ignores prose around the object", () => {
    const text = 'Here is my decision:\n{"action":"pay","confidence":0.9}\nLet me know.';
    expect(extractJson(text)).toEqual({ action: "pay", confidence: 0.9 });
  });

  it("keeps nested objects intact", () => {
    const text = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJson(text)).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("throws on output with no object at all", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object/);
  });

  it("throws on a malformed object rather than guessing", () => {
    expect(() => extractJson('{"action": pay}')).toThrow();
  });
});

const schema = z.object({ action: z.enum(["pay", "hold"]), confidence: z.number() });

const noProvider = configWith(llm());
const withDeepSeek = configWith(llm({ deepseek: { apiKey: "k" } }));

/** Runs a decision for a business whose only provider is DeepSeek. */
const decideAsDeepSeek = <T,>(params: Parameters<typeof decide<T>>[0]) =>
  runWithConfig(withDeepSeek, () => decide(params));
const fallback = () => ({ action: "hold" as const, confidence: 0.5 });

describe("decide", () => {
  it("uses the heuristic and labels it as such when no provider is configured", async () => {
    const result = await runWithConfig(noProvider, () =>
      decide({ systemPrompt: "s", userPrompt: "u", schema, fallback })
    );
    expect(result).toMatchObject({ value: { action: "hold", confidence: 0.5 }, mode: "heuristic" });
    // In heuristic mode the reference IS the decision, so agreement is not a
    // defined quantity and must not be reported as agreement.
    expect(result.reference).toEqual(result.value);
    expect(result.agreedWithReference).toBeNull();
  });

  it("returns the model's decision, labelled with the provider that made it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"action":"pay","confidence":0.91}' } }],
        }),
        { status: 200 }
      )
    );

    const result = await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result).toMatchObject({ value: { action: "pay", confidence: 0.91 }, mode: "deepseek" });
    // The rule-based policy said hold; the model said pay. That divergence is
    // the whole eval signal and has to survive into the result.
    expect(result.reference).toEqual({ action: "hold", confidence: 0.5 });
    expect(result.agreedWithReference).toBe(false);
  });

  it("falls back to the heuristic when the provider is down", async () => {
    // A rate-limited model must not stop the treasury — but the ledger has to
    // record the heuristic as the author, not the model.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 })
    );

    const result = await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
    expect(result.value).toEqual({ action: "hold", confidence: 0.5 });
  });

  it("falls back when the model returns valid JSON in the wrong shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"wire_it_all"}' } }] }),
        { status: 200 }
      )
    );

    const result = await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
  });

  it("falls back when the model returns no content", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 })
    );

    expect((await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback })).mode).toBe(
      "heuristic"
    );
  });

  it("falls back when the network call throws outright", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    expect((await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback })).mode).toBe(
      "heuristic"
    );
  });

  it("sends the system prompt and the business context to the provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"pay","confidence":1}' } }] }),
        { status: 200 }
      )
    );

    await decideAsDeepSeek({
      systemPrompt: "never pay high risk",
      userPrompt: '{"invoice":{"amount":240}}',
      schema,
      fallback,
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.messages).toEqual([
      { role: "system", content: "never pay high risk" },
      { role: "user", content: '{"invoice":{"amount":240}}' },
    ]);
  });

  it("does not call out at all when pinned to the heuristic", async () => {
    const pinned = configWith(llm({ provider: "heuristic", deepseek: { apiKey: "k" } }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await runWithConfig(pinned, () => decide({ systemPrompt: "s", userPrompt: "u", schema, fallback }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("decide — one retry on a malformed reply", () => {
  it("recovers a decision the model first returned unusably", async () => {
    // Before this retry existed, a stray word outside the JSON cost the whole
    // decision: the agent dropped silently to the heuristic and a money
    // decision lost the judgement it was about to apply.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "I cannot comply." } }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"action":"pay","confidence":0.8}' } }] }),
          { status: 200 }
        )
      );

    const result = await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("deepseek");
    expect(result.value).toEqual({ action: "pay", confidence: 0.8 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("shows the model its own rejection rather than repeating the prompt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "no json here" } }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"action":"hold","confidence":0.6}' } }] }),
          { status: 200 }
        )
      );

    await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "original context", schema, fallback });

    const retryBody = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    const retryUser = retryBody.messages[1].content;
    expect(retryUser).toContain("original context");
    expect(retryUser).toContain("could not be used");
    expect(retryUser).toContain("no JSON object");
  });

  it("does not retry a rate limit, which repeating cannot fix", async () => {
    // Retrying a 429 spends another call to be refused again, and on a
    // treasury cycle that is real money and real latency.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("rate limited", { status: 429 }));

    const result = await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a dead socket", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up after one retry rather than looping", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "still not json" } }] }), {
        status: 200,
      })
    );

    const result = await decideAsDeepSeek({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
