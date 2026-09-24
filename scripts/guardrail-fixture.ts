/**
 * Adds one explicitly labelled demo probe where the model verdict is "pay"
 * but the same production guardrail used by the orchestrator refuses it.
 * No transfer provider is called. Safe to re-run: an existing probe is kept.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const [{ supabase, unwrap }, { screenCounterparty }, { appendLedgerEntry }, { enforceApGuardrails }] = await Promise.all([
    import("../src/lib/supabase"),
    import("../src/lib/compliance"),
    import("../src/lib/ledger"),
    import("../src/lib/agent/guardrails"),
  ]);
  const db = supabase();
  const name = "Wardrobe Holdings Guardrail Fixture";
  const memo = "Guardrail probe — model chose pay above screened limit";

  const existingInvoice = await db.from("invoices").select("id").eq("memo", memo).limit(1).maybeSingle<{ id: string }>();
  if (existingInvoice.error) throw new Error(existingInvoice.error.message);
  if (existingInvoice.data) {
    console.log(`Guardrail probe already exists: invoice ${existingInvoice.data.id}`);
    return;
  }

  const existingCounterparty = await db.from("counterparties").select("id").eq("name", name).limit(1).maybeSingle<{ id: string }>();
  if (existingCounterparty.error) throw new Error(existingCounterparty.error.message);
  const counterparty = existingCounterparty.data ?? unwrap(
    await db.from("counterparties").insert({
      name,
      role: "vendor",
      chain: "ARC-TESTNET",
      baseline_payment_limit: "2.000000",
      payment_limit: null,
    }).select("id").single<{ id: string }>()
  );
  const screening = await screenCounterparty(counterparty.id);
  if (screening.riskLevel !== "medium" || screening.newPaymentLimit !== 0.5) {
    throw new Error(`Expected medium risk with 0.5 USDC authority, got ${screening.riskLevel}/${screening.newPaymentLimit}`);
  }

  const invoice = unwrap(
    await db.from("invoices").insert({
      direction: "payable",
      counterparty_id: counterparty.id,
      amount: "0.900000",
      memo,
      po_reference: "PO-GUARDRAIL-PROBE",
      goods_received: true,
      due_date: new Date(Date.now() + 86_400_000).toISOString(),
    }).select("id").single<{ id: string }>()
  );
  const modelDecision = {
    action: "pay" as const,
    reasoning: "The purchase order and receipt match, so the model recommends paying 0.9 USDC.",
    confidence: 0.82,
  };
  const guardrail = enforceApGuardrails({
    action: modelDecision.action,
    reasoning: modelDecision.reasoning,
    amount: 0.9,
    riskLevel: screening.riskLevel,
    paymentLimit: screening.newPaymentLimit,
  });
  if (!guardrail.blocked || guardrail.status !== "held") throw new Error("Guardrail probe did not block as expected");

  const decidedAt = new Date().toISOString();
  const update = await db.from("invoices").update({
    status: guardrail.status,
    agent_reasoning: guardrail.reasoning,
    decided_at: decidedAt,
  }).eq("id", invoice.id);
  if (update.error) throw new Error(update.error.message);

  await appendLedgerEntry({
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: `REFUSED fixture payment to ${name} for 0.9 USDC`,
    detail: {
      invoiceId: invoice.id,
      decision: modelDecision,
      decisionMode: "fixture:model-verdict",
      guardrailBlocked: true,
      guardrailRule: guardrail.rule,
      guardrailFixture: true,
      observed: {
        amount: 0.9,
        paymentLimit: screening.newPaymentLimit,
        riskLevel: screening.riskLevel,
        poReference: "PO-GUARDRAIL-PROBE",
        goodsReceived: true,
      },
      execution: { txRef: null, resultingStatus: "held", settlementRequired: false, providerCalled: false },
    },
  });

  console.log(`Created guardrail probe invoice ${invoice.id}; model said pay, code refused, provider was not called.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
