import { encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { toBaseUnits } from "../fx/quote";
import { ARC_TESTNET_USDC } from "./cctp";
import type { BatchTransfer } from "./types";

/**
 * Arc testnet's Multicall3From (batch payouts §1): it batches calls like Multicall3, but each call keeps
 * the caller as `msg.sender`, through Arc's CallFrom precompile. A USDC `transfer` inside the batch is a
 * transfer from the operating wallet itself.
 */
export const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";

/** The most transfers one batch carries (R1); more are split into batches of this size. */
export const MAX_BATCH_SIZE = 20;

const MULTICALL = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/**
 * `aggregate3`'s call for a batch: one `USDC.transfer(payee, amount)` per payment, in order, none allowed
 * to fail, so a batch moves every payment or none (R2). Amounts in USDC's 6-decimal base units, never by
 * a float multiply.
 */
export function batchCallData(transfers: BatchTransfer[]): Hex {
  if (transfers.length < 2 || transfers.length > MAX_BATCH_SIZE) {
    throw new Error(`A batch carries 2 to ${MAX_BATCH_SIZE} transfers, not ${transfers.length}; nothing was sent.`);
  }
  const calls = transfers.map((transfer) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(transfer.toAddress)) {
      throw new Error(`A batch can only pay an Arc address, not ${transfer.toAddress}; nothing was sent.`);
    }
    if (!(transfer.amount > 0)) throw new Error(`A batch transfer must be more than 0 USDC, not ${transfer.amount}; nothing was sent.`);
    return {
      target: ARC_TESTNET_USDC as Hex,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: ERC20,
        functionName: "transfer",
        // Lowercased first: a stored address in mixed case with a wrong checksum is still the same address.
        args: [getAddress(transfer.toAddress.toLowerCase()), BigInt(toBaseUnits(transfer.amount))],
      }),
    };
  });
  return encodeFunctionData({ abi: MULTICALL, functionName: "aggregate3", args: [calls] });
}
