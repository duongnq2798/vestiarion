import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decide, extractJson, selectProvider } from "@/lib/agent/decide";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "AGENT_LLM_PROVIDER",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("selectProvider", () => {
  it("falls back to the heuristic when nothing is configured", () => {
    expect(selectProvider()).toBe("heuristic");
  });

  it("prefers Anthropic when several keys are present", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.OPENAI_API_KEY = "b";
    process.env.DEEPSEEK_API_KEY = "c";
    expect(selectProvider()).toBe("anthropic");
  });

  it("falls through the preference order to the key that exists", () => {
    process.env.DEEPSEEK_API_KEY = "c";
    expect(selectProvider()).toBe("deepseek");
  });

  it("honours an explicit choice over the preference order", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.DEEPSEEK_API_KEY = "c";
    process.env.AGENT_LLM_PROVIDER = "deepseek";
    expect(selectProvider()).toBe("deepseek");
  });

  it("accepts the explicit choice case-insensitively", () => {
    process.env.DEEPSEEK_API_KEY = "c";
    process.env.AGENT_LLM_PROVIDER = "DeepSeek";
    expect(selectProvider()).toBe("deepseek");
  });

  it("throws rather than silently billing a different provider", () => {
    // Pinning a provider whose key is missing is a configuration mistake. The
    // dangerous behaviour would be quietly using whichever key *is* present.
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.AGENT_LLM_PROVIDER = "openai";
    expect(() => selectProvider()).toThrow(/OPENAI_API_KEY is not set/);
  });

  it("lets the heuristic be pinned even when keys are available", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.AGENT_LLM_PROVIDER = "heuristic";
    expect(selectProvider()).toBe("heuristic");
  });

  it("ignores an unrecognised provider name and auto-selects", () => {
    process.env.DEEPSEEK_API_KEY = "c";
    process.env.AGENT_LLM_PROVIDER = "llama";
    expect(selectProvider()).toBe("deepseek");
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
const fallback = () => ({ action: "hold" as const, confidence: 0.5 });

describe("decide", () => {
  it("uses the heuristic and labels it as such when no key is set", async () => {
    const result = await decide({
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      fallback,
    });
    expect(result).toMatchObject({ value: { action: "hold", confidence: 0.5 }, mode: "heuristic" });
    // In heuristic mode the reference IS the decision, so agreement is not a
    // defined quantity and must not be reported as agreement.
    expect(result.reference).toEqual(result.value);
    expect(result.agreedWithReference).toBeNull();
  });

  it("returns the model's decision, labelled with the provider that made it", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"action":"pay","confidence":0.91}' } }],
        }),
        { status: 200 }
      )
    );

    const result = await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result).toMatchObject({ value: { action: "pay", confidence: 0.91 }, mode: "deepseek" });
    // The rule-based policy said hold; the model said pay. That divergence is
    // the whole eval signal and has to survive into the result.
    expect(result.reference).toEqual({ action: "hold", confidence: 0.5 });
    expect(result.agreedWithReference).toBe(false);
  });

  it("falls back to the heuristic when the provider is down", async () => {
    // A rate-limited model must not stop the treasury — but the ledger has to
    // record the heuristic as the author, not the model.
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 })
    );

    const result = await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
    expect(result.value).toEqual({ action: "hold", confidence: 0.5 });
  });

  it("falls back when the model returns valid JSON in the wrong shape", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"wire_it_all"}' } }] }),
        { status: 200 }
      )
    );

    const result = await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
  });

  it("falls back when the model returns no content", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 })
    );

    expect((await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback })).mode).toBe(
      "heuristic"
    );
  });

  it("falls back when the network call throws outright", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    expect((await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback })).mode).toBe(
      "heuristic"
    );
  });

  it("sends the system prompt and the business context to the provider", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"pay","confidence":1}' } }] }),
        { status: 200 }
      )
    );

    await decide({
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
    process.env.DEEPSEEK_API_KEY = "k";
    process.env.AGENT_LLM_PROVIDER = "heuristic";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("decide — one retry on a malformed reply", () => {
  it("recovers a decision the model first returned unusably", async () => {
    // Before this retry existed, a stray word outside the JSON cost the whole
    // decision: the agent dropped silently to the heuristic and a money
    // decision lost the judgement it was about to apply.
    process.env.DEEPSEEK_API_KEY = "k";
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

    const result = await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("deepseek");
    expect(result.value).toEqual({ action: "pay", confidence: 0.8 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("shows the model its own rejection rather than repeating the prompt", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
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

    await decide({ systemPrompt: "s", userPrompt: "original context", schema, fallback });

    const retryBody = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    const retryUser = retryBody.messages[1].content;
    expect(retryUser).toContain("original context");
    expect(retryUser).toContain("could not be used");
    expect(retryUser).toContain("no JSON object");
  });

  it("does not retry a rate limit, which repeating cannot fix", async () => {
    // Retrying a 429 spends another call to be refused again, and on a
    // treasury cycle that is real money and real latency.
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("rate limited", { status: 429 }));

    const result = await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a dead socket", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up after one retry rather than looping", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "still not json" } }] }), {
        status: 200,
      })
    );

    const result = await decide({ systemPrompt: "s", userPrompt: "u", schema, fallback });
    expect(result.mode).toBe("heuristic");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
