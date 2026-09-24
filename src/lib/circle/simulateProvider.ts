import { supabase, unwrap } from "../supabase";
import type {
  BalanceSnapshot,
  ChainProvider,
  EarnDepositParams,
  EarnResult,
  TransferParams,
  TransferResult,
} from "./types";
import { ARC_FEE_USD, ARC_SETTLEMENT_MS_MAX, ARC_SETTLEMENT_MS_MIN } from "./types";

interface AccountRow {
  id: string;
  chain: string;
  token: string;
  balance: string;
  apy: string;
}

/**
 * Deterministic stand-in for Arc + Circle's stack. It mutates the same
 * `accounts` rows the rest of the app reads and applies Arc's fee and latency
 * profile — both now calibrated from real Arc-testnet executions read back off
 * the chain, rather than from the round numbers this file used to assert. See
 * the constants in `./types.ts` for the measurements and what they replaced.
 *
 * It requires no Circle credentials; `LiveProvider` replaces it automatically
 * once they are configured. Simulated rows are labelled `simulated_profile`
 * and are excluded from every median the app reports, so a calibrated
 * simulator improves the demo without ever being mistaken for evidence.
 */
export class SimulateProvider implements ChainProvider {
  readonly mode = "simulate" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = ARC_FEE_USD;

  private async account(id: string): Promise<AccountRow> {
    return unwrap(
      await supabase().from("accounts").select("*").eq("id", id).single<AccountRow>()
    );
  }

  private async addBalance(id: string, delta: number, current: number): Promise<void> {
    const next = Number((current + delta).toFixed(6));
    const res = await supabase().from("accounts").update({ balance: next }).eq("id", id);
    if (res.error) throw new Error(res.error.message);
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    const account = await this.account(params.fromAccountId);
    const balance = Number(account.balance);
    if (balance < params.amount) {
      throw new Error(
        `Insufficient balance: account holds ${balance}, tried to send ${params.amount}`
      );
    }
    await this.addBalance(account.id, -params.amount, balance);
    const providerTxId = `sim_${params.idempotencyKey}`;
    return {
      providerTxId,
      txHash: providerTxId,
      txRef: providerTxId,
      chain: account.chain,
      status: "confirmed",
      feeUsd: ARC_FEE_USD,
      feeSource: "simulated_profile",
      providerMode: "simulate",
      settledInMs:
        ARC_SETTLEMENT_MS_MIN +
        Math.floor(Math.random() * (ARC_SETTLEMENT_MS_MAX - ARC_SETTLEMENT_MS_MIN + 1)),
    };
  }

  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return {
      providerTxId,
      txHash: providerTxId,
      txRef: providerTxId,
      chain: "ARC-TESTNET",
      status: "confirmed",
      feeUsd: ARC_FEE_USD,
      feeSource: "simulated_profile",
      providerMode: "simulate",
      settledInMs: 0,
    };
  }

  async depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    const account = await this.account(params.accountId);
    const balance = Number(account.balance);
    if (balance < params.amount) throw new Error("Insufficient balance for USYC deposit");
    await this.addBalance(account.id, -params.amount, balance);
    return {
      txRef: `sim_earn_${crypto.randomUUID().slice(0, 12)}`,
      positionValue: params.amount,
      apy: Number(account.apy),
    };
  }

  async withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    const account = await this.account(params.accountId);
    await this.addBalance(account.id, params.amount, Number(account.balance));
    return {
      txRef: `sim_redeem_${crypto.randomUUID().slice(0, 12)}`,
      positionValue: params.amount,
      apy: Number(account.apy),
    };
  }

  async getBalance(accountId: string): Promise<BalanceSnapshot> {
    const account = await this.account(accountId);
    return {
      accountId,
      chain: account.chain,
      token: account.token,
      balance: Number(account.balance),
    };
  }
}
