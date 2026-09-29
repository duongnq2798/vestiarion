import net from "node:net";

/**
 * Where a webhook may be sent (docs/superpowers/specs/2026-09-29-webhooks-design.md, W6).
 *
 * - `validateWebhookUrl` checks the URL itself, for the form and again at send
 *   time: https, port 443 or none, no credentials, at most 500 characters, and
 *   a literal IP host must be public. No DNS: a host name is resolved once, by
 *   the sender's pinned lookup at connect time (`./http.ts`), which refuses it
 *   unless every address is public.
 * - `isPublicAddress` is the address rule. IPv4 refuses this-network,
 *   private, CGNAT, loopback, link-local, IETF protocol assignments,
 *   benchmarking, documentation, multicast and reserved space. IPv6 allows
 *   only global unicast (2000::/3) outside documentation and Teredo; an
 *   address that carries an IPv4 one — IPv4-mapped (::ffff:0:0/96), NAT64
 *   (64:ff9b::/96) or 6to4 (2002::/16) — is judged by that IPv4 address.
 *   Anything that does not parse as an address is not public.
 */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const URL_MAX = 500;

/** `validateWebhookUrl`'s reason for a literal IP host that is not public. */
export const URL_NOT_PUBLIC = "the URL's address is not public";

/** [first address, prefix length] of each refused IPv4 range. */
const REFUSED_V4: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast (224/4) and reserved (240/4), broadcast included
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

const REFUSED_V4_RANGES = REFUSED_V4.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = v4ToInt(base);
  return { start, end: start + size - 1 };
});

function isPublicV4Int(value: number): boolean {
  return !REFUSED_V4_RANGES.some(({ start, end }) => value >= start && value <= end);
}

/**
 * The 16-bit groups of an address `net.isIP` has already judged IPv6, with no
 * zone or brackets. A dotted IPv4 tail ("::ffff:127.0.0.1") becomes the last
 * two groups.
 */
function v6Groups(ip: string): number[] {
  let text = ip;
  const tail: number[] = [];
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const value = v4ToInt(text.slice(lastColon + 1));
    tail.push(Math.floor(value / 65536), value % 65536);
    // Keep a "::" that ends right before the IPv4 part; drop a lone separator.
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const gap = text.indexOf("::");
  let groups: number[];
  if (gap >= 0) {
    const head = parse(text.slice(0, gap));
    const rest = parse(text.slice(gap + 2));
    groups = [...head, ...Array(8 - tail.length - head.length - rest.length).fill(0), ...rest];
  } else {
    groups = parse(text);
  }
  return [...groups, ...tail];
}

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return false;
  const v4At = (hi: number, lo: number) => g[hi] * 65536 + g[lo];

  // IPv4-mapped ::ffff:a.b.c.d
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return isPublicV4Int(v4At(6, 7));
  // NAT64 64:ff9b::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isPublicV4Int(v4At(6, 7));
  // Only global unicast from here: this refuses ::, ::1, IPv4-compatible ::/96,
  // fc00::/7, fe80::/10, ff00::/8 and everything else unassigned.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  // 6to4 2002:aabb:ccdd::/48 carries a.b.c.d
  if (g[0] === 0x2002) return isPublicV4Int(v4At(1, 2));
  // Teredo 2001::/32 and documentation 2001:db8::/32
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false;
  return true;
}

/** True only for a syntactically valid IPv4 or IPv6 address that is publicly routable. */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false;
  let text = ip.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  switch (net.isIP(text)) {
    case 4:
      return isPublicV4Int(v4ToInt(text));
    case 6:
      return isPublicV6(text.toLowerCase());
    default:
      return false;
  }
}

/** The URL's own rules (W6), with no DNS. The returned URL is the normalised one to store and send to. */
export function validateWebhookUrl(raw: string): UrlCheck {
  if (typeof raw !== "string") return { ok: false, reason: "not a valid URL" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "the URL must use https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "the URL must not contain credentials" };
  // The URL parser drops the default port, so any port left is not 443.
  if (url.port !== "") return { ok: false, reason: "the URL must use port 443" };
  if (url.href.length > URL_MAX) return { ok: false, reason: `the URL must be at most ${URL_MAX} characters` };
  const host = url.hostname;
  if ((net.isIP(host) !== 0 || host.startsWith("[")) && !isPublicAddress(host)) {
    return { ok: false, reason: URL_NOT_PUBLIC };
  }
  return { ok: true, url };
}
