import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decide } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import { runWith, runWithConfig } from "@/lib/context";
import { sendEmail } from "@/lib/email/send";
import { recordUsage, usageRow } from "@/lib/usage/record";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Recording what a workspace used (docs/superpowers/specs/2026-10-13-accountant-console-design.md U1): one row through
 * the workspace's own client, in its scope only, never failing what it records; a model call with the tokens its
 * provider reported and its cost where the price is known; an email by what it was for, never its address or words.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

afterEach(() => vi.restoreAllMocks());

function scope(respond: (sent: RecordedRequest) => FakeReply = () => ({ status: 201, body: [] }), config = base) {
  const fake = fakeSupabase(respond);
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  const inserts = () => fake.requests.filter((sent) => sent.path === "/rest/v1/usage_events" && sent.method === "POST");
  return { fake, run, inserts };
}

describe("recordUsage", () => {
  it("adds one row, stamped with the workspace in scope", async () => {
    const { run, inserts } = scope();
    await run(() => recordUsage({ kind: "x402_purchase", action: "payee_history", provider: "x402", cost: { amount: 0.01, currency: "USDC" } }));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].body).toEqual({
      org_id: ORG, kind: "x402_purchase", action: "payee_history", provider: "x402", model: null, quantity: 1,
      input_tokens: null, output_tokens: null, cost: "0.010000", cost_currency: "USDC", ok: true,
    });
  });

  it("records nothing outside a workspace's scope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await runWithConfig(base, () => recordUsage({ kind: "email", action: "invitation" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws: a refused insert, and a table not there yet, are logged at most", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = scope(() => ({ status: 500, body: { message: "boom" } }));
    await expect(refused.run(() => recordUsage({ kind: "email", action: "invitation" }))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("usage: not recorded", "email", "invitation");
    error.mockClear();
    const missing = scope(() => ({ status: 404, body: { code: "PGRST205", message: "no table" } }));
    await missing.run(() => recordUsage({ kind: "email", action: "invitation" }));
    expect(error).not.toHaveBeenCalled();
  });

  it("refuses an event that does not read, rather than write free words", async () => {
    expect(usageRow({ kind: "email", action: "Sent to ana@example.com" })).toBeNull();
    expect(usageRow({ kind: "email", action: "invitation", cost: { amount: "-1", currency: "USD" } })).toMatchObject({ cost: null, cost_currency: null });
    expect(usageRow({ kind: "model_call", action: "payable", inputTokens: -5, outputTokens: 12.4 })).toMatchObject({ input_tokens: null, output_tokens: 12 });
  });
});

describe("metering a model call", () => {
  const schema = z.object({ action: z.enum(["pay", "hold"]) });
  const fallback = () => ({ action: "hold" as const });

  it("records a DeepSeek call with its tokens, and its cost from the deployment's price", async () => {
    const config = { ...base, llm: { deepseek: { apiKey: "d" }, prices: { "deepseek-chat": { input: 0.28, output: 0.42 } } } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"pay"}' } }], usage: { prompt_tokens: 1200, completion_tokens: 80 } }), { status: 200 })
    );
    const { run, inserts } = scope(undefined, config);
    const result = await run(() => decide({ systemPrompt: "s", userPrompt: "u", schema, fallback, purpose: "payable" }));
    expect(result.mode).toBe("deepseek");
    expect(inserts().map((sent) => sent.body)).toEqual([
      {
        org_id: ORG, kind: "model_call", action: "payable", provider: "deepseek", model: "deepseek-chat", quantity: 1,
        input_tokens: 1200, output_tokens: 80, cost: "0.000370", cost_currency: "USD", ok: true,
      },
    ]);
  });

  it("records both calls of a retried reply, and a failed call without tokens", async () => {
    const config = { ...base, llm: { deepseek: { apiKey: "d" } } };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 }))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { run, inserts } = scope(undefined, config);
    const result = await run(() => decide({ systemPrompt: "s", userPrompt: "u", schema, fallback }));
    expect(result.mode).toBe("heuristic");
    expect(inserts().map((sent) => (sent.body as Record<string, unknown>))).toEqual([
      expect.objectContaining({ action: "decision", input_tokens: 10, output_tokens: 5, cost: null, ok: true }),
      expect.objectContaining({ action: "decision", model: null, input_tokens: null, ok: false }),
    ]);
  });
});

describe("metering an email", () => {
  it("records what an email was for and whether Resend took it, never the address", async () => {
    const resend: typeof fetch = async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    const { run, inserts } = scope();
    await run(() => sendEmail({ to: "ana@example.com", subject: "s", html: "h", text: "t", meter: "invitation" }, { apiKey: "re", from: "a@vestiarion.xyz" }, resend));
    expect(inserts().map((sent) => sent.body)).toEqual([expect.objectContaining({ kind: "email", action: "invitation", provider: "resend", ok: true })]);
    expect(JSON.stringify(inserts()[0].body)).not.toContain("ana@example.com");
  });

  it("records nothing for an email that names no purpose, or with no email configured", async () => {
    const resend: typeof fetch = async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    const { run, inserts } = scope();
    await run(() => sendEmail({ to: "ana@example.com", subject: "s", html: "h", text: "t" }, { apiKey: "re", from: "a@vestiarion.xyz" }, resend));
    await run(() => sendEmail({ to: "ana@example.com", subject: "s", html: "h", text: "t", meter: "invitation" }, null, resend));
    expect(inserts()).toHaveLength(0);
  });
});
