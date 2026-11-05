/**
 * The email an invoice came from, against the vendor's on file (docs/superpowers/specs/2026-11-05-check-invoice-design.md
 * IC3): the same, one made to look like it, a free mail address, an invoicing service's, or another. Pure and run in the
 * browser.
 */

export interface Email {
  /** Lowercase; null when only a domain was given. */
  address: string | null;
  /** Lowercase, without a trailing dot. */
  domain: string;
  /** An address written in the sender's name that is not the sender's: `"ap@northwind.com" <billing@evil.io>`. */
  shown: string | null;
}

/** At most this much of a field or a header line is read for an email, so a long paste stays fast. */
const EMAIL_TEXT_MAX = 320;
const EMAIL = /[^\s<>@,;:"'()[\]]{1,64}@[^\s<>@,;:"'()[\]]{1,255}/g;
const BARE_DOMAIN = /^@?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\.?$/i;

function parts(found: string): { address: string; domain: string } | null {
  const address = found.replace(/[.]+$/, "").toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1).replace(/[.]+$/, "");
  return domain.includes(".") ? { address, domain } : null;
}

/**
 * The sender's email in `text`, which may be written "Name <name@example.com>": the address in the last angle
 * brackets, else the first address. An address in the name before it that is not the sender's is kept as `shown`.
 * A domain alone, such as `northwind.com`, is read too, for the one on file. Null when there is neither.
 */
export function readEmail(raw: string): Email | null {
  const text = raw.slice(0, EMAIL_TEXT_MAX).trim();
  const bracketed = [...text.matchAll(/<([^<>]{3,320})>/g)].pop();
  const inBrackets = bracketed ? parts(bracketed[1].match(EMAIL)?.[0] ?? "") : null;
  if (inBrackets) {
    const before = text.slice(0, bracketed!.index);
    const other = [...before.matchAll(EMAIL)].map((match) => parts(match[0])).find((each) => each && each.address !== inBrackets.address);
    return { ...inBrackets, shown: other?.address ?? null };
  }
  const first = text.match(EMAIL)?.[0];
  if (first) {
    const read = parts(first);
    return read ? { ...read, shown: null } : null;
  }
  const bare = text.match(BARE_DOMAIN);
  return bare ? { address: null, domain: bare[1].toLowerCase(), shown: null } : null;
}

/** A domain in the ASCII form it is sent in, so `exämple.com` and its `xn--` form compare as one. */
export function asciiDomain(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

/** Endings of two labels that a business registers its name under, as `northwind.co.uk`. */
const TWO_LABEL_ENDINGS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp",
  "co.za", "com.br", "com.mx", "com.sg", "com.hk", "co.in", "co.kr", "com.tr", "com.cn", "com.tw", "co.il", "com.ar",
  "com.my", "com.ph", "co.id", "co.th", "com.ng", "co.ke",
]);
/** Labels that, before a country's two letters, are part of the ending: `com.vn`, `net.pl`, `gob.mx`. */
const GENERIC_SECOND = new Set(["com", "net", "org", "co", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "biz"]);
/** Hosts where anyone can have a name of their own: the name is the label before them. */
const SHARED_HOSTS = new Set([
  "onmicrosoft.com", "sharepoint.com", "github.io", "vercel.app", "netlify.app", "pages.dev", "herokuapp.com", "web.app",
  "firebaseapp.com", "blogspot.com", "wixsite.com", "myshopify.com", "square.site", "carrd.co", "notion.site",
]);

/** A domain's registered name and its ending: `billing.northwind.co.uk` is `northwind` under `co.uk`. */
export function registered(domain: string): { name: string; ending: string } {
  const labels = domain.split(".");
  const two = labels.slice(-2).join(".");
  const take =
    labels.length >= 3 && (TWO_LABEL_ENDINGS.has(two) || SHARED_HOSTS.has(two) || (GENERIC_SECOND.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2)) ? 3 : 2;
  const kept = labels.slice(-take);
  return { name: kept[0] ?? domain, ending: kept.slice(1).join(".") };
}

/** Free mail services by their registered name, under any ending (`yahoo.co.uk`), and a few by their whole domain. */
const FREE_MAIL_NAMES = new Set(["gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "ymail", "aol", "icloud", "gmx", "yandex", "protonmail", "tutanota", "fastmail", "zoho", "mail", "qq", "163"]);
const FREE_MAIL_DOMAINS = new Set(["proton.me", "pm.me", "me.com", "mac.com", "tuta.io", "hey.com", "gmx.de", "web.de", "t-online.de", "orange.fr", "free.fr", "libero.it"]);

/** Whether `domain` is a free mail service anyone can open an address with. */
export function isFreeMail(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain) || FREE_MAIL_NAMES.has(registered(domain).name);
}

/** Invoicing and payment services that send a business's invoices from their own address. */
const INVOICE_SERVICES: ReadonlyArray<{ name: string; domains: readonly string[] }> = [
  { name: "Xero", domains: ["xero.com"] },
  { name: "QuickBooks", domains: ["intuit.com", "quickbooks.com"] },
  { name: "Stripe", domains: ["stripe.com"] },
  { name: "FreshBooks", domains: ["freshbooks.com"] },
  { name: "Bill.com", domains: ["bill.com"] },
  { name: "Sage", domains: ["sage.com"] },
  { name: "Square", domains: ["squareup.com"] },
  { name: "PayPal", domains: ["paypal.com"] },
  { name: "Zoho", domains: ["zohoinvoice.com", "zohobooks.com"] },
  { name: "Wave", domains: ["waveapps.com"] },
  { name: "Invoice2go", domains: ["invoice2go.com"] },
  { name: "Melio", domains: ["meliopayments.com"] },
];

/** The invoicing service `domain` belongs to, if any. */
export function invoiceService(domain: string): string | null {
  return INVOICE_SERVICES.find((service) => service.domains.some((each) => domain === each || domain.endsWith(`.${each}`)))?.name ?? null;
}

/** Whether a domain is written with letters outside ASCII, or in the `xn--` form such a domain is sent in. */
export function foreignLetters(domain: string): boolean {
  return /[^\x21-\x7e]/.test(domain) || domain.split(".").some((label) => label.startsWith("xn--"));
}

/** A name with the letters that look alike read as one: `rn` as `m`, `vv` as `w`, `cl` as `d`, `0` as `o`, `1` and `i` as `l`, `5` as `s`. */
function skeleton(name: string): string {
  return name.replace(/[-._]/g, "").replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/0/g, "o").replace(/[1i]/g, "l").replace(/5/g, "s");
}

/** The fewest letters changed, added, removed or swapped side by side to turn one name into the other. */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

/** How two names, of a domain or an address's part before the @, are made to look alike, if they are. */
export function alikeNames(known: string, given: string): "added" | "letters" | "lookalike" | null {
  const a = known.replace(/[-._]/g, "");
  const b = given.replace(/[-._]/g, "");
  if (a === b) return known === given ? null : "added";
  if (skeleton(known) === skeleton(given)) return "lookalike";
  if (a.length >= 4 && b.length >= 4 && (b.includes(a) || a.includes(b))) return "added";
  if (Math.min(a.length, b.length) >= 4 && editDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1)) return "letters";
  return null;
}

export type DomainMatch =
  | { kind: "same" }
  | { kind: "alike"; how: "ending" | "added" | "letters" | "lookalike" }
  | { kind: "foreign" }
  | { kind: "free" }
  | { kind: "other" };

/** The invoice's domain against the one on file (IC3). */
export function compareDomains(onFile: string, invoice: string): DomainMatch {
  const a = asciiDomain(onFile);
  const b = asciiDomain(invoice);
  if (a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`)) return { kind: "same" };
  if (foreignLetters(invoice) || foreignLetters(b)) return { kind: "foreign" };
  const known = registered(a);
  const given = registered(b);
  if (known.name === given.name && known.ending === given.ending) return { kind: "same" };
  if (known.name === given.name) return { kind: "alike", how: "ending" };
  const how = alikeNames(known.name, given.name);
  if (how) return { kind: "alike", how };
  // The vendor's name as a label of someone else's domain: northwind.com.evil.io.
  if (known.name.length >= 4 && b.split(".").slice(0, -2).includes(known.name)) return { kind: "alike", how: "added" };
  if (isFreeMail(b) && !isFreeMail(a)) return { kind: "free" };
  return { kind: "other" };
}
