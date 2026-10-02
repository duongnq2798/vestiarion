import { encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { toBaseUnits } from "../fx/quote";
import { ARC_TESTNET_USDC } from "./cctp";
import type { BatchTransfer } from "./types";

/**
 * A Circle smart account's own batch (Circle, "Batch operations"; batch payouts §2): a contract execution
 * whose contract is the wallet itself, calling `executeBatch`. The wallet then calls each target in order,
 * as itself, and reverts every call if one fails.
 *
 * Not Arc's Multicall3From: its CallFrom precompile keeps the sender only when the sender is tx.origin, and
 * a smart account's transaction is sent by Circle's bundler. Circle refused that batch at estimation,
 * "sender spoofing requires tx.origin as sender" (testnet-2, 2026-10-02); nothing moved.
 */
export const SCA_EXECUTE_BATCH = "executeBatch((address,uint256,bytes)[])";

/** The most transfers one batch carries (R1); more are split into batches of this size. */
export const MAX_BATCH_SIZE = 20;

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** A batch that could not be built: nothing reached Circle, so each payment can be sent alone at once. */
export class BatchNotSentError extends Error {
  constructor(message: string) {
    super(`${message}; nothing was sent.`);
    this.name = "BatchNotSentError";
  }
}

/**
 * `executeBatch`'s calls for a batch, as Circle's `abiParameters` take them: one
 * `[USDC, "0", transfer(payee, amount)]` per payment, in order. Amounts in USDC's 6-decimal base units,
 * never by a float multiply.
 */
export function batchCalls(transfers: BatchTransfer[]): Array<[string, string, Hex]> {
  if (transfers.length < 2 || transfers.length > MAX_BATCH_SIZE) {
    throw new BatchNotSentError(`A batch carries 2 to ${MAX_BATCH_SIZE} transfers, not ${transfers.length}`);
  }
  return transfers.map((transfer) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(transfer.toAddress)) throw new BatchNotSentError(`A batch can only pay an Arc address, not ${transfer.toAddress}`);
    if (!(transfer.amount > 0)) throw new BatchNotSentError(`A batch transfer must be more than 0 USDC, not ${transfer.amount}`);
    // Lowercased first: a stored address in mixed case with a wrong checksum is still the same address.
    const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(transfer.toAddress.toLowerCase()), BigInt(toBaseUnits(transfer.amount))] });
    return [ARC_TESTNET_USDC, "0", data];
  });
}
