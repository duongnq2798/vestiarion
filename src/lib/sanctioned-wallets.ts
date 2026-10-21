import snapshot from "./data/ofac-sdn-evm-wallets.json";
import { rowsFromCsv } from "./csv-rows";

/**
 * The payout addresses on OFAC's SDN list (docs/superpowers/specs/2026-10-21-sanctioned-wallets-design.md): the list's
 * "Digital Currency Address" entries in the EVM format Arc and the chains it pays use, whatever currency the entry
 * names (ETH, USDT, USDC, ARB…). The Treasury publishes the list as two files: an entry's remarks that overflow
 * `SDN.CSV` continue in `SDN_COMMENTS.CSV`, and an address can straddle the two, so they are read together.
 *
 * A production deployment reads the live files and keeps them 12 hours per instance (SW2). Anywhere else, or when the
 * files cannot be read, the snapshot bundled with the code answers, dated, so a lookup never depends on the network.
 */

export const OFAC_SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
export const OFAC_SDN_COMMENTS_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_COMMENTS.CSV";
/** How long a live read is kept before the next one (SW2). */
export const SANCTIONED_WALLETS_TTL_MS = 12 * 3_600_000;
/** Fewer addresses than this in a live read means the files were not what they should be (SW2): the snapshot stays. */
export const SANCTIONED_WALLETS_MIN = 50;
const READ_TIMEOUT_MS = 20_000;

export interface SanctionedWallet {
  /** Lowercase, `0x` and 40 hex digits. */
  address: string;
  /** The SDN entry's number, which OFAC's own search finds. */
  entityNumber: string;
  name: string;
  /** The currencies the entry names for this address, such as `ETH` or `USDT`. */
  currencies: string[];
}

export interface SanctionedWalletList {
  /** `live`: read from OFAC's files; `snapshot`: the copy bundled with the code. */
  from: "live" | "snapshot";
  /** When the files were read: for the snapshot, the day it was made. */
  readAt: string;
  wallets: ReadonlyMap<string, SanctionedWallet>;
}

const ADDRESS = /Digital Currency Address - ([A-Z0-9]+) (0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/** The EVM addresses in OFAC's two SDN files, each once, with the entry and every currency it is listed under (SW1). */
export function parseSdnWallets(sdnCsv: string, commentsCsv: string): Map<string, SanctionedWallet> {
  const overflow = new Map<string, string>();
  for (const row of rowsFromCsv(commentsCsv)) {
    const [number, text] = row;
    if (!number || text === undefined) continue;
    overflow.set(number.trim(), (overflow.get(number.trim()) ?? "") + text);
  }
  const wallets = new Map<string, SanctionedWallet>();
  for (const row of rowsFromCsv(sdnCsv)) {
    const number = row[0]?.trim();
    if (!number) continue;
    const remarks = (row[11] ?? "") + (overflow.get(number) ?? "");
    for (const match of remarks.matchAll(ADDRESS)) {
      const address = match[2].toLowerCase();
      const found = wallets.get(address);
      if (found) {
        if (!found.currencies.includes(match[1])) found.currencies.push(match[1]);
        continue;
      }
      wallets.set(address, { address, entityNumber: number, name: (row[1] ?? "").trim(), currencies: [match[1]] });
    }
  }
  return wallets;
}

const SNAPSHOT: SanctionedWalletList = {
  from: "snapshot",
  readAt: snapshot.readAt,
  wallets: new Map(snapshot.wallets.map((wallet) => [wallet.address, wallet])),
};

let cached: SanctionedWalletList | null = null;

/** The list a lookup can use at once, without the network: the last live read, or the snapshot (SW3). */
export function cachedSanctionedWallets(): SanctionedWalletList {
  return cached ?? SNAPSHOT;
}

/**
 * The list, read again from OFAC when `live` and the last read is older than its TTL (SW2). A read that fails, times
 * out or finds too few addresses keeps what there was: the last live read, else the snapshot. Never throws.
 */
export async function loadSanctionedWallets(options: { live: boolean; fetch?: typeof fetch; now?: number }): Promise<SanctionedWalletList> {
  if (!options.live) return cachedSanctionedWallets();
  const now = options.now ?? Date.now();
  if (cached && now - Date.parse(cached.readAt) < SANCTIONED_WALLETS_TTL_MS) return cached;
  const read = options.fetch ?? fetch;
  try {
    const text = async (url: string) => {
      const response = await read(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return response.text();
    };
    const [sdn, comments] = await Promise.all([text(OFAC_SDN_URL), text(OFAC_SDN_COMMENTS_URL)]);
    const wallets = parseSdnWallets(sdn, comments);
    if (wallets.size < SANCTIONED_WALLETS_MIN) throw new Error(`only ${wallets.size} addresses read`);
    cached = { from: "live", readAt: new Date(now).toISOString(), wallets };
  } catch (error) {
    console.error("sanctioned wallets not read; the last list stays", error instanceof Error ? error.message : "unknown error");
  }
  return cachedSanctionedWallets();
}

/** The list's entry for an address, in any case, or null (SW1). */
export function sanctionedWallet(list: SanctionedWalletList, address: string | null | undefined): SanctionedWallet | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return list.wallets.get(address.toLowerCase()) ?? null;
}

/** Forgets the live read, for tests. */
export function resetSanctionedWalletsForTests(): void {
  cached = null;
}
