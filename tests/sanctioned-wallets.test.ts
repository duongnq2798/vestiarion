import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { configFromEnv } from "@/lib/config";
import {
  cachedSanctionedWallets,
  loadSanctionedWallets,
  OFAC_SDN_COMMENTS_URL,
  OFAC_SDN_URL,
  parseSdnWallets,
  resetSanctionedWalletsForTests,
  SANCTIONED_WALLETS_MIN,
  SANCTIONED_WALLETS_RETRY_MS,
  SANCTIONED_WALLETS_TTL_MS,
  sanctionedWallet,
} from "@/lib/sanctioned-wallets";

/**
 * OFAC's sanctioned payout addresses (docs/superpowers/specs/2026-10-21-sanctioned-wallets-design.md SW1 to SW3): the
 * EVM addresses in the SDN list's "Digital Currency Address" remarks, read from both of the Treasury's files, live in
 * production and kept 12 hours, else the snapshot bundled with the code.
 */

const hex = (seed: number) => seed.toString(16).padStart(40, "0");
/** An SDN.CSV row: entry number, name, then the eleventh column, the remarks. */
const sdnRow = (number: string, name: string, remarks: string) =>
  `${number},"${name}","-0- ","CYBER2","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","${remarks}"`;

const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

describe("parseSdnWallets (SW1)", () => {
  it("reads every EVM address an entry lists, once, with each currency it is listed under", () => {
    const sdn = [
      sdnRow("100", "LAZARUS GROUP", `Digital Currency Address - ETH ${MIXED}; Digital Currency Address - USDT ${MIXED.toLowerCase()}; Digital Currency Address - XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT; alt. Digital Currency Address - ARB 0x${hex(7)}.`),
      sdnRow("200", "SOMEONE ELSE", "Nationality Russia; Digital Currency Address - ETH 0x" + "1".repeat(41)),
    ].join("\n");
    const wallets = parseSdnWallets(sdn, "");
    expect([...wallets.keys()]).toEqual([MIXED.toLowerCase(), `0x${hex(7)}`]);
    expect(wallets.get(MIXED.toLowerCase())).toEqual({ address: MIXED.toLowerCase(), entityNumber: "100", name: "LAZARUS GROUP", currencies: ["ETH", "USDT"] });
  });

  it("reads CRLF files and remarks with commas inside their quotes", () => {
    const sdn = [sdnRow("400", "COMMA, NAME", `Website x.test, y.test; Digital Currency Address - ETH 0x${hex(4)}; alt.`), sdnRow("401", "NEXT", `Digital Currency Address - USDT 0x${hex(5)}`)].join("\r\n");
    const wallets = parseSdnWallets(sdn, "");
    expect(wallets.get(`0x${hex(4)}`)).toMatchObject({ entityNumber: "400", name: "COMMA, NAME" });
    expect(wallets.get(`0x${hex(5)}`)).toMatchObject({ entityNumber: "401", currencies: ["USDT"] });
  });

  it("joins an entry's remarks that overflow into SDN_COMMENTS.CSV, so an address split between the files is read", () => {
    const address = `0x${hex(0xabcdef)}`;
    const sdn = sdnRow("300", "SPLIT ENTRY", `Digital Currency Address - ETH ${address.slice(0, 12)}`);
    const comments = `300,"${address.slice(12)}; Digital Currency Address - USDC 0x${hex(9)}"`;
    const wallets = parseSdnWallets(sdn, comments);
    expect(wallets.get(address)).toMatchObject({ entityNumber: "300", currencies: ["ETH"] });
    expect(wallets.get(`0x${hex(9)}`)).toMatchObject({ entityNumber: "300", currencies: ["USDC"] });
  });
});

describe("sanctionedWallet", () => {
  const list = { from: "snapshot" as const, readAt: "2026-10-21T00:00:00.000Z", wallets: parseSdnWallets(sdnRow("100", "LAZARUS GROUP", `Digital Currency Address - ETH ${MIXED}`), "") };

  it("finds an address in any case", () => {
    expect(sanctionedWallet(list, MIXED)?.entityNumber).toBe("100");
    expect(sanctionedWallet(list, MIXED.toUpperCase().replace("0X", "0x"))?.entityNumber).toBe("100");
  });

  it("finds nothing for another address, no address, or one that is not an EVM address", () => {
    expect(sanctionedWallet(list, `0x${hex(1)}`)).toBeNull();
    expect(sanctionedWallet(list, null)).toBeNull();
    expect(sanctionedWallet(list, "1BoatSLRHtKNngkdXEeobR76b53LETtpyT")).toBeNull();
  });
});

describe("the bundled snapshot (SW3)", () => {
  it("holds the SDN list's EVM addresses, lowercase, each once, in order, with their entries", () => {
    expect(snapshot.source).toBe("OFAC SDN list");
    expect(Number.isNaN(Date.parse(snapshot.readAt))).toBe(false);
    expect(snapshot.wallets.length).toBeGreaterThanOrEqual(SANCTIONED_WALLETS_MIN);
    const addresses = snapshot.wallets.map((wallet) => wallet.address);
    expect(addresses.every((address) => /^0x[0-9a-f]{40}$/.test(address))).toBe(true);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect([...addresses].sort()).toEqual(addresses);
    for (const wallet of snapshot.wallets) {
      expect(wallet.entityNumber).toMatch(/^\d+$/);
      expect(wallet.name.length).toBeGreaterThan(0);
      expect(wallet.currencies.length).toBeGreaterThan(0);
    }
  });

  it("answers a lookup when nothing was read live", () => {
    resetSanctionedWalletsForTests();
    const first = snapshot.wallets[0];
    expect(cachedSanctionedWallets().from).toBe("snapshot");
    expect(sanctionedWallet(cachedSanctionedWallets(), first.address)).toMatchObject({ entityNumber: first.entityNumber });
  });
});

describe("loadSanctionedWallets (SW2)", () => {
  const NOW = Date.parse("2026-10-21T08:00:00Z");
  const manyRows = Array.from({ length: 70 }, (_, index) => sdnRow(String(1000 + index), `ENTRY ${index}`, `Digital Currency Address - ETH 0x${hex(0x1000 + index)}`)).join("\r\n");
  const COMMENTS = '1000,"Website www.example.test, more remarks"';
  const files = (sdn: string, status = 200, comments = COMMENTS) =>
    vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      void _init;
      if (String(url) === OFAC_SDN_URL) return new Response(sdn, { status });
      if (String(url) === OFAC_SDN_COMMENTS_URL) return new Response(comments, { status });
      return new Response("", { status: 404 });
    });

  beforeEach(() => resetSanctionedWalletsForTests());
  afterEach(() => vi.restoreAllMocks());

  it("reads nothing when not live: the snapshot answers", async () => {
    const fetch = files(manyRows);
    const list = await loadSanctionedWallets({ live: false, fetch, now: NOW });
    expect(list).toMatchObject({ from: "snapshot", readAt: snapshot.readAt });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads both files live, keeps them 12 hours, then reads them again", async () => {
    const fetch = files(manyRows);
    const list = await loadSanctionedWallets({ live: true, fetch, now: NOW });
    expect(list.from).toBe("live");
    expect(list.readAt).toBe("2026-10-21T08:00:00.000Z");
    expect(list.wallets.size).toBe(70);
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual([OFAC_SDN_COMMENTS_URL, OFAC_SDN_URL].sort());

    await loadSanctionedWallets({ live: true, fetch, now: NOW + SANCTIONED_WALLETS_TTL_MS - 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cachedSanctionedWallets().from).toBe("live");

    await loadSanctionedWallets({ live: true, fetch, now: NOW + SANCTIONED_WALLETS_TTL_MS });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps the snapshot when a file cannot be read, the comments file is empty, or too few addresses are read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await loadSanctionedWallets({ live: true, fetch: files(manyRows, 503), now: NOW })).from).toBe("snapshot");
    resetSanctionedWalletsForTests();
    expect((await loadSanctionedWallets({ live: true, fetch: files(manyRows, 200, ""), now: NOW })).from).toBe("snapshot");
    resetSanctionedWalletsForTests();
    // Fewer than half the snapshot's addresses is more likely a broken file than OFAC's list.
    const half = Array.from({ length: Math.floor(snapshot.wallets.length / 2) - 1 }, (_, index) => sdnRow(String(index), "E", `Digital Currency Address - ETH 0x${hex(0x5000 + index)}`)).join("\n");
    expect((await loadSanctionedWallets({ live: true, fetch: files(half), now: NOW })).from).toBe("snapshot");
    expect(console.error).toHaveBeenCalledWith("sanctioned wallets not read; the last list stays", expect.any(String));
  });

  it("waits 30 minutes after a failed read before trying again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = files(manyRows, 503);
    await loadSanctionedWallets({ live: true, fetch: failing, now: NOW });
    const working = files(manyRows);
    expect((await loadSanctionedWallets({ live: true, fetch: working, now: NOW + SANCTIONED_WALLETS_RETRY_MS - 1 })).from).toBe("snapshot");
    expect(working).not.toHaveBeenCalled();
    expect((await loadSanctionedWallets({ live: true, fetch: working, now: NOW + SANCTIONED_WALLETS_RETRY_MS })).from).toBe("live");
  });

  it("shares one read among the callers that ask while it runs, and asks without the HTTP cache", async () => {
    const fetch = files(manyRows);
    const lists = await Promise.all([1, 2, 3, 4].map(() => loadSanctionedWallets({ live: true, fetch, now: NOW })));
    expect(lists.every((list) => list.from === "live")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("keeps the last live read when a later read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await loadSanctionedWallets({ live: true, fetch: files(manyRows), now: NOW });
    const later = await loadSanctionedWallets({ live: true, fetch: files("", 500), now: NOW + SANCTIONED_WALLETS_TTL_MS + 1 });
    expect(later).toMatchObject({ from: "live", readAt: "2026-10-21T08:00:00.000Z" });
  });
});

describe("which list a deployment reads (SW2)", () => {
  const base = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };

  it("reads live on a production deployment, or when asked, and keeps the snapshot anywhere else or when told to", () => {
    expect(configFromEnv({ ...base, VERCEL_ENV: "production" }).compliance.sanctionedWalletsLive).toBe(true);
    expect(configFromEnv({ ...base, SANCTIONED_WALLETS: "live" }).compliance.sanctionedWalletsLive).toBe(true);
    expect(configFromEnv({ ...base }).compliance.sanctionedWalletsLive).toBeUndefined();
    expect(configFromEnv({ ...base, VERCEL_ENV: "preview" }).compliance.sanctionedWalletsLive).toBeUndefined();
    expect(configFromEnv({ ...base, VERCEL_ENV: "production", SANCTIONED_WALLETS: "snapshot" }).compliance.sanctionedWalletsLive).toBeUndefined();
  });
});
