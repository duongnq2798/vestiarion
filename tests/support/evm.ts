import { createEVM, type EVM } from "@ethereumjs/evm";
import { Address, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * An in-process EVM for the escrow's tests: deploy a compiled contract, call it as any address at any block
 * time, read what it returned, whether it reverted and with which custom error, and its logs. A minimal ABI
 * encoder covers the types the escrow uses: address, uint256, uint64, bytes32.
 */

export type AbiValue = { type: "address"; value: string } | { type: "uint"; value: bigint } | { type: "bytes32"; value: string };

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export function selector(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 10);
}

export function encode(args: AbiValue[]): string {
  return args
    .map((arg) => (arg.type === "uint" ? word(arg.value.toString(16)) : arg.type === "address" ? word(arg.value) : arg.value.replace(/^0x/, "").padEnd(64, "0")))
    .join("");
}

export const address = (value: string): AbiValue => ({ type: "address", value });
export const uint = (value: bigint | number): AbiValue => ({ type: "uint", value: BigInt(value) });
export const bytes32 = (value: string): AbiValue => ({ type: "bytes32", value });

export interface CallResult {
  reverted: boolean;
  /** The 4-byte selector of the custom error it reverted with, when it did. */
  error: string | null;
  returned: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export class TestChain {
  private constructor(private readonly evm: EVM) {}
  timestamp = BigInt(1_800_000_000);

  static async start(): Promise<TestChain> {
    return new TestChain(await createEVM());
  }

  private block() {
    return {
      header: {
        number: BigInt(1),
        coinbase: createAddressFromString(`0x${"0".repeat(40)}`),
        timestamp: this.timestamp,
        difficulty: BigInt(0),
        prevRandao: new Uint8Array(32),
        gasLimit: BigInt(30_000_000),
        baseFeePerGas: BigInt(0),
        getBlobGasPrice: () => undefined,
      },
    };
  }

  async deploy(bytecode: string, args: AbiValue[], from: string): Promise<string> {
    const result = await this.evm.runCall({
      caller: createAddressFromString(from),
      data: hexToBytes(`${bytecode}${encode(args)}` as `0x${string}`),
      gasLimit: BigInt(10_000_000),
      block: this.block(),
    });
    if (result.execResult.exceptionError || !result.createdAddress) throw new Error(`deploy failed: ${result.execResult.exceptionError?.error}`);
    return result.createdAddress.toString();
  }

  async call(to: string, signature: string, args: AbiValue[], from: string): Promise<CallResult> {
    const result = await this.evm.runCall({
      caller: createAddressFromString(from),
      to: new Address(hexToBytes(to as `0x${string}`)),
      data: hexToBytes(`${selector(signature)}${encode(args)}` as `0x${string}`),
      gasLimit: BigInt(1_000_000),
      block: this.block(),
    });
    const returned = bytesToHex(result.execResult.returnValue);
    const reverted = Boolean(result.execResult.exceptionError);
    return {
      reverted,
      error: reverted && returned.length >= 10 ? returned.slice(0, 10) : null,
      returned,
      logs: (result.execResult.logs ?? []).map(([logAddress, topics, data]) => ({
        address: bytesToHex(logAddress),
        topics: topics.map((topic) => bytesToHex(topic)),
        data: bytesToHex(data),
      })),
    };
  }

  /** A view's single uint256 answer. */
  async readUint(to: string, signature: string, args: AbiValue[]): Promise<bigint> {
    const result = await this.call(to, signature, args, `0x${"9".repeat(40)}`);
    if (result.reverted) throw new Error(`${signature} reverted`);
    return BigInt(result.returned.slice(0, 66));
  }

  /** A view's answer, as 32-byte words. */
  async readWords(to: string, signature: string, args: AbiValue[]): Promise<string[]> {
    const result = await this.call(to, signature, args, `0x${"9".repeat(40)}`);
    if (result.reverted) throw new Error(`${signature} reverted`);
    return result.returned.slice(2).match(/.{64}/g) ?? [];
  }
}
