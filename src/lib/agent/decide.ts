import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";

/**
 * Every "should the agent actually do this" question passes through here.
 * The caller supplies the live business context and the JSON shape it wants
 * back; this module gets a decision plus the reasoning behind it, which the
 * orchestrator writes verbatim into the ledger. That is what makes the
 * agent's choices auditable instead of a black box.
 *
 * Three providers are supported — Anthropic, OpenAI, and DeepSeek — plus a
 * transparent rule-based heuristic. With no `AGENT_LLM_PROVIDER` set, the
 * first configured key wins in that order. The heuristic is not a degraded
 * mode to be embarrassed about: it is the same policy the system prompt
 * describes, written out in code, so the app runs end-to-end with no
 * credentials at all and the two paths can be compared directly.
 *
 * The returned `mode` is recorded on every ledger entry, so an auditor can
 * always tell which path produced a given decision.
 */

export type DecisionMode = "anthropic" | "openai" | "deepseek" | "heuristic";

export interface DecideParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  fallback: () => T;
}

export interface DecideResult<T> {
  value: T;
  mode: DecisionMode;
}

let anthropicClient: Anthropic | undefined;

const KEY_FOR: Record<Exclude<DecisionMode, "heuristic">, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const PREFERENCE: Array<Exclude<DecisionMode, "heuristic">> = [
  "anthropic",
  "openai",
  "deepseek",
];

export function selectProvider(): DecisionMode {
  const configured = process.env.AGENT_LLM_PROVIDER?.toLowerCase();

  if (configured === "heuristic") return "heuristic";
  if (configured && configured in KEY_FOR) {
    const provider = configured as Exclude<DecisionMode, "heuristic">;
    // An explicit choice whose key is missing is a configuration mistake, not
    // an invitation to quietly bill a different provider.
    if (!process.env[KEY_FOR[provider]]) {
      throw new Error(
        `AGENT_LLM_PROVIDER=${provider} but ${KEY_FOR[provider]} is not set`
      );
    }
    return provider;
  }

  return PREFERENCE.find((p) => process.env[KEY_FOR[p]]) ?? "heuristic";
}

/**
 * Models are asked for bare JSON, but they still wrap it in prose or a code
 * fence often enough that parsing has to tolerate both.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

async function callAnthropic(params: DecideParams<unknown>): Promise<string> {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  const response = await anthropicClient.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
    max_tokens: 1024,
    system: params.systemPrompt,
    messages: [{ role: "user", content: params.userPrompt }],
  });
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** OpenAI and DeepSeek both speak the OpenAI chat-completions dialect. */
async function callOpenAICompatible(
  params: DecideParams<unknown>,
  config: { label: string; baseUrl: string; apiKey: string; model: string }
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`${config.label} returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${config.label} returned no content`);
  return content;
}

function callOpenAI(params: DecideParams<unknown>): Promise<string> {
  return callOpenAICompatible(params, {
    label: "OpenAI",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL ?? "gpt-5",
  });
}

function callDeepSeek(params: DecideParams<unknown>): Promise<string> {
  return callOpenAICompatible(params, {
    label: "DeepSeek",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  });
}

const CALLERS: Record<
  Exclude<DecisionMode, "heuristic">,
  (params: DecideParams<unknown>) => Promise<string>
> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  deepseek: callDeepSeek,
};

export async function decide<T>(params: DecideParams<T>): Promise<DecideResult<T>> {
  const provider = selectProvider();
  if (provider === "heuristic") {
    return { value: params.fallback(), mode: "heuristic" };
  }

  try {
    const text = await CALLERS[provider](params as DecideParams<unknown>);
    return { value: params.schema.parse(extractJson(text)), mode: provider };
  } catch (err) {
    // A model that is down, rate-limited, or returns unparseable output must
    // not stop the treasury from running — but the fallback is recorded as
    // such in the ledger rather than passed off as the model's judgement.
    console.error(`[agent] ${provider} decision failed, falling back to heuristic:`, err);
    return { value: params.fallback(), mode: "heuristic" };
  }
}
