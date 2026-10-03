import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { keywordIntent, routeText } from "@/lib/telegram/route-text";

/**
 * What a member's plain words ask for (Telegram bot design R9): the model picks one of five questions, code answers
 * it. With no model, or a model that answers outside the five, the keywords decide, in English and in Vietnamese.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const withDeepSeek = { ...config, llm: { deepseek: { apiKey: "d" } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

const INVOICE_TEXT = [
  "INVOICE INV-2207",
  "From: Northwind Hosting, 12 Harbour Road",
  "Bill to: Acme & Sons",
  "Hosting for October, 3 servers",
  "Amount due: 1,250.00 USDC",
  "Due date: 2026-10-31",
].join("\n");

describe("keywordIntent", () => {
  it.each([
    ["how much can I spend today?", "today"],
    ["what's our balance", "today"],
    ["số dư hôm nay bao nhiêu", "today"],
    ["what is held?", "waiting"],
    ["anything waiting for approval", "waiting"],
    ["có khoản nào đang chờ duyệt không", "waiting"],
    ["is the ledger intact?", "ledger"],
    ["sổ cái còn nguyên vẹn không", "ledger"],
    ["hi", "help"],
    ["pay Jiren now", "help"],
    [INVOICE_TEXT, "invoice"],
  ])("routes %j to %s", (text, intent) => {
    expect(keywordIntent(text)).toBe(intent);
  });
});

function deepSeekAnswering(...contents: string[]) {
  const prompts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
      prompts.push(body.messages.find((message) => message.role === "user")?.content ?? "");
      const content = contents[Math.min(prompts.length - 1, contents.length - 1)];
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    })
  );
  return prompts;
}

describe("routeText", () => {
  it("lets the keywords decide when no model is configured", async () => {
    expect(await runWithConfig(config, () => routeText("có khoản nào đang chờ duyệt không"))).toEqual({ intent: "waiting", mode: "heuristic" });
  });

  it("takes the model's choice of the five", async () => {
    deepSeekAnswering('{"intent":"ledger"}');
    expect(await runWithConfig(withDeepSeek, () => routeText("has anyone changed our records?"))).toEqual({ intent: "ledger", mode: "deepseek" });
  });

  it("falls back to the keywords when the model answers outside the five", async () => {
    deepSeekAnswering('{"intent":"pay_now"}');
    expect(await runWithConfig(withDeepSeek, () => routeText("what is held?"))).toEqual({ intent: "waiting", mode: "heuristic" });
  });

  it("shows the model at most 4,000 characters of a long message", async () => {
    const prompts = deepSeekAnswering('{"intent":"invoice"}');
    await runWithConfig(withDeepSeek, () => routeText(`${INVOICE_TEXT}\n${"line item 10.00 USDC\n".repeat(400)}`));
    expect(prompts[0].length).toBeLessThan(4_600);
    expect(prompts[0]).toContain("INV-2207");
  });
});
