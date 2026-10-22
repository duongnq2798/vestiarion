import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { parseAddressInput } from "@/lib/counterparty-address";
import { allowedGateway, clearEnsCache, ENS_GATEWAY_HOSTS, ENS_RPC_DEFAULT, primaryName, resolveAddressName } from "@/lib/ens";
import { isAddressName, NAME_NOT_ADDRESS, nameMatchesPayee, shortened } from "@/lib/ens-words";
import { ENS_RPC_HOST } from "@/lib/subprocessors";

/**
 * ENS names and Basenames in an address field (docs/superpowers/specs/2026-10-22-ens-address-names-design.md EN1-EN4):
 * what reads as a name, a name never saved as an address, the lookup both ways through a node that is never asked twice in
 * ten minutes, whether a name looks like the payee, and the only gateway the server fetches.
 */

vi.mock("server-only", () => ({}));

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWithConfig(config, fn);

beforeEach(() => clearEnsCache());

describe("what reads as a name (EN1, EN2)", () => {
  it("takes an ENS name or a Basename, and nothing else", () => {
    for (const name of ["vitalik.eth", "jesse.base.eth", "Northwind-Pay.eth", "pay.northwind.eth"]) expect(isAddressName(name), name).toBe(true);
    for (const value of ["vitalik", "vitalik.com", ".eth", "-bad.eth", VITALIK, "a..eth", "x.eth.com", ""]) expect(isAddressName(value), value).toBe(false);
  });

  it("is never saved as an address: the field says to use the address it points to", () => {
    expect(parseAddressInput("vitalik.eth")).toEqual({ ok: false, message: NAME_NOT_ADDRESS, checksum: false });
    expect(parseAddressInput(VITALIK)).toEqual({ ok: true, address: VITALIK });
  });
});

describe("whether a name looks like the payee (EN3)", () => {
  it("matches a name that carries one of the payee's words, or reads the same without spaces", () => {
    expect(nameMatchesPayee("northwind.eth", "Northwind Supply LLC")).toBe(true);
    expect(nameMatchesPayee("pay-northwind.base.eth", "Northwind Supply")).toBe(true);
    expect(nameMatchesPayee("acmestudio.eth", "Acme Studio")).toBe(true);
    // A subname is read by the name it sits under: billing.acme.eth by acme.
    expect(nameMatchesPayee("billing.acme.eth", "Acme")).toBe(true);
    expect(nameMatchesPayee("acme.evil.eth", "Acme")).toBe(false);
    expect(nameMatchesPayee("acme.eth", "Acme")).toBe(true);
    expect(nameMatchesPayee("cheap-usdc.eth", "Northwind Supply")).toBe(false);
  });

  it("has nothing to compare for a payee with no usable word, so it raises no question", () => {
    expect(nameMatchesPayee("anything.eth", "Co")).toBe(true);
    expect(shortened(VITALIK)).toBe("0xd8dA...6045");
  });
});

describe("looking names up (EN1)", () => {
  it("resolves a name to its checksummed address, normalized, and asks the node once in ten minutes", async () => {
    const client = { getEnsAddress: vi.fn(async () => VITALIK.toLowerCase() as `0x${string}`), getEnsName: vi.fn() };
    const found = await run(() => resolveAddressName(" Vitalik.ETH ", { client: client as never, now: 1_000 }));
    expect(found).toEqual({ name: "vitalik.eth", address: VITALIK });
    expect(client.getEnsAddress).toHaveBeenCalledWith({ name: "vitalik.eth" });
    await run(() => resolveAddressName("vitalik.eth", { client: client as never, now: 1_000 + 9 * 60_000 }));
    expect(client.getEnsAddress).toHaveBeenCalledTimes(1);
    await run(() => resolveAddressName("vitalik.eth", { client: client as never, now: 1_000 + 11 * 60_000 }));
    expect(client.getEnsAddress).toHaveBeenCalledTimes(2);
  });

  it("answers null for a name that points nowhere, and for what is not a name, without asking", async () => {
    const client = { getEnsAddress: vi.fn(async () => null), getEnsName: vi.fn() };
    expect(await run(() => resolveAddressName("nobody-here.eth", { client: client as never }))).toBeNull();
    expect(await run(() => resolveAddressName("not a name", { client: client as never }))).toBeNull();
    expect(client.getEnsAddress).toHaveBeenCalledTimes(1);
  });

  it("reads an address's primary name", async () => {
    const client = { getEnsAddress: vi.fn(), getEnsName: vi.fn(async () => "vitalik.eth") };
    expect(await run(() => primaryName(VITALIK.toLowerCase(), { client: client as never }))).toBe("vitalik.eth");
    expect(client.getEnsName).toHaveBeenCalledWith({ address: VITALIK });
  });
});

describe("where the server looks names up (EN4)", () => {
  it("fetches a CCIP-read gateway only over https on Coinbase's host, never one a resolver makes up", () => {
    expect(ENS_GATEWAY_HOSTS).toEqual(["api.coinbase.com"]);
    expect(allowedGateway("https://api.coinbase.com/api/v1/domain/resolver/resolveDomain/{sender}/{data}")).toBe(true);
    for (const url of [
      "http://api.coinbase.com/x",
      "https://api.coinbase.com:8443/x",
      "https://evil.example/{sender}",
      "https://api.coinbase.com.evil.example/x",
      "http://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "not a url",
    ]) {
      expect(allowedGateway(url), url).toBe(false);
    }
  });

  it("names PublicNode's Ethereum node as the default, as the privacy page lists it", () => {
    expect(ENS_RPC_DEFAULT).toBe("https://ethereum-rpc.publicnode.com");
    expect(ENS_RPC_HOST).toBe("ethereum-rpc.publicnode.com");
    expect(configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://x.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", ENS_RPC_URL: " https://eth.example/rpc " }).chain.ensRpcUrl).toBe(
      "https://eth.example/rpc"
    );
  });
});
