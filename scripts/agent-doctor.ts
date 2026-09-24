/**
 * Checks which LLM provider the agent will actually use, and proves it can
 * return a decision in the required shape.
 *
 *   npm run agent:doctor
 */
import { config } from "dotenv";
import { z } from "zod";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { decide, selectProvider } = await import("../src/lib/agent/decide");

  console.log(`ANTHROPIC_API_KEY:  ${process.env.ANTHROPIC_API_KEY ? "present" : "absent"}`);
  console.log(`OPENAI_API_KEY:     ${process.env.OPENAI_API_KEY ? "present" : "absent"}`);
  console.log(`DEEPSEEK_API_KEY:   ${process.env.DEEPSEEK_API_KEY ? "present" : "absent"}`);
  console.log(`AGENT_LLM_PROVIDER: ${process.env.AGENT_LLM_PROVIDER ?? "(auto)"}`);
  console.log(`selected provider:  ${selectProvider()}\n`);

  const schema = z.object({
    action: z.enum(["pay", "hold", "flag_fraud", "request_info"]),
    reasoning: z.string().min(10),
    confidence: z.number().min(0).max(1),
  });

  const result = await decide({
    systemPrompt:
      "You are a treasury agent. Never pay a counterparty flagged high risk. Respond with ONLY a JSON object.",
    userPrompt: JSON.stringify({
      task: "Decide whether to pay this invoice.",
      invoice: { amount: 2600, poReference: null, goodsReceived: false },
      counterparty: { name: "Zenith Trading LLC", riskLevel: "high", paymentLimit: 0 },
      responseShape: {
        action: "pay | hold | flag_fraud | request_info",
        reasoning: "string",
        confidence: "number between 0 and 1",
      },
    }),
    schema,
    fallback: () => ({
      action: "flag_fraud" as const,
      reasoning: "heuristic fallback: counterparty is high risk",
      confidence: 0.95,
    }),
  });

  console.log(`decision mode: ${result.mode}`);
  console.log(JSON.stringify(result.value, null, 2));

  if (result.mode === "heuristic") {
    console.log("\nNo LLM was used. Set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY for real reasoning.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
