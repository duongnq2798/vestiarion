import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { BRAND_FILES, BrandMark, BrandName, isWordmark, PROVIDER_MARKS, type Brand } from "@/components/vx/BrandMarks";
import { PROVIDERS } from "@/lib/connectors/provider";

/**
 * The marks of the services Vestiarion integrates with
 * (docs/superpowers/specs/2026-10-07-brand-marks-design.md,
 * docs/superpowers/specs/2026-10-12-integration-marks-design.md): only those the code
 * integrates with, each its owner's file unaltered, beside its name, and never
 * worded as an endorsement.
 */

const BRANDS: Brand[] = [
  "arc",
  "circle",
  "slack",
  "telegram",
  "npm",
  "xero",
  "quickbooks",
  "quickbooks-lockup",
  "hubspot",
  "pipedrive",
  "pipedrive-lockup",
  "asana-lockup",
];

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The owners' files, byte for byte as their brand kits publish them: a change
 * here is a recoloured, cropped or redrawn mark, which their guidelines forbid.
 * QuickBooks' symbol is the lockup's circle in a file of its own, held below to
 * the lockup's own paths.
 */
const OFFICIAL_SHA256: Record<Brand, string> = {
  arc: "4f5bed3cc8c8ebb91a855e74b4d02d72d66e311b0080d0b94cd8a9900669f60f",
  circle: "3cd2066548be9f3c9a4f3e65fa577afd6cb00595311b1ca507e3358a92b60697",
  slack: "3b4e08eefa709e2a6209f116a0493c323da6a3a73713666fb524ccb91a95e8dd",
  telegram: "d8ea6a30260ef60f3a68c7bd994e5a3ed5740431128a854e2f5003beafda58bd",
  npm: "bdb2b11ee23be03be4dd31264e336f952c0ffe61699a237c511dc5d9afc6d77e",
  // Xero's wordmark in midnight, Intuit's QuickBooks lockup and its circle, HubSpot's sprocket in its orange.
  xero: "289380e0285b688c13f3197861499fbe49e84414741a8353c22c8c28bd19d02b",
  quickbooks: "ec993a3485cbe0bdf4a7ac1527a2976be78a3267084df11ac526d3924eafdfee",
  "quickbooks-lockup": "d5cac311a6a1de8e7df8af756c6db7aa4a50120a5d0dd4ae2d543947e39d176a",
  hubspot: "789c8d1786fa8364ccce35f9f7fdf8cd489cbf99ade53ee631c95a085d5cb550",
  // Pipedrive's app icon and its dark wordmark, and Asana's logo, from their brand kits.
  pipedrive: "45f867120bc5459c83f3148b5f0f9678e8228f6820940e1d8262756a6979b3e5",
  "pipedrive-lockup": "9f3315ca31f3698bd1e73ebd6430e8d0bbb23b84bfcada5261bbab0dcfdd594a",
  "asana-lockup": "8a951a5126a6b1de833f5354102ba995eec1003cc76e79dd8401c890d987c1b5",
};

const brandFile = (brand: Brand) => readFileSync(path.join(process.cwd(), "public", BRAND_FILES[brand]), "utf8");

/** The colours a mark's paths draw in, read from its file (a clip rectangle's fill draws nothing, so it is left out). */
const fills = (brand: Brand) => [...brandFile(brand).matchAll(/<path[^>]*fill="(#[0-9a-fA-F]{6}|white|currentColor)"/g)].map((match) => match[1].toLowerCase());

/** WCAG relative luminance and contrast, for a mark's colour on the site's grounds. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("a brand mark", () => {
  it("is its owner's file, unaltered, served from public/brands", () => {
    expect(Object.keys(BRAND_FILES)).toEqual(BRANDS);
    for (const brand of BRANDS) {
      expect(BRAND_FILES[brand]).toMatch(new RegExp(`^/brands/${brand}\\.(svg|jpeg)$`));
      const bytes = readFileSync(path.join(process.cwd(), "public", BRAND_FILES[brand]));
      expect(createHash("sha256").update(bytes).digest("hex"), brand).toBe(OFFICIAL_SHA256[brand]);
    }
  });

  it("is decoration beside a name: an empty alt, hidden from assistive technology, never recoloured", () => {
    for (const brand of BRANDS) {
      const markup = renderToStaticMarkup(<BrandMark brand={brand} />);
      // React may add a preload <link> for the image ahead of it; the <img> itself is what matters.
      expect(markup).toMatch(new RegExp(`<img src="${BRAND_FILES[brand].replace(".", "\\.")}" alt="" aria-hidden="true"`));
      expect(markup).toContain(`data-brand="${brand}"`);
      expect(markup).not.toMatch(/filter|opacity|mix-blend|grayscale|text-ink/);
    }
  });

  it("shows Slack's mark at the others' height without cutting its clear space", () => {
    // 16 px tall: the file is drawn larger and pulled in by its clear space on every side.
    const slack = renderToStaticMarkup(<BrandMark brand="slack" />);
    expect(slack).toMatch(/width="35" height="35"/);
    expect(slack).toMatch(/style="margin:-9\.\d+px"/);
    expect(renderToStaticMarkup(<BrandMark brand="circle" />)).toMatch(/width="16" height="16"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="npm" />)).toMatch(/width="41" height="16"/);
  });

  it("draws the new marks in proportion: Xero's wordmark shorter, QuickBooks' lockup with its circle at the symbols' height", () => {
    // Xero at three quarters of the height, 210:60, its letters as tall as a name's capitals; HubSpot's sprocket 22:26.
    expect(renderToStaticMarkup(<BrandMark brand="xero" />)).toMatch(/width="42" height="12"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="hubspot" />)).toMatch(/width="14" height="16"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="quickbooks" />)).toMatch(/width="16" height="16"(?![^>]*style)/);
    // The lockup is 955:274 and its circle 227.5 of the 274: 19 px tall puts the circle at 16, as tall as the symbols.
    expect(renderToStaticMarkup(<BrandMark brand="quickbooks-lockup" />)).toMatch(/width="67" height="19"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="xero" size={24} />)).toMatch(/width="63" height="18"/);
    expect(renderToStaticMarkup(<BrandMark brand="quickbooks" size={24} />)).toMatch(/width="24" height="24"/);
    expect(renderToStaticMarkup(<BrandMark brand="hubspot" size={24} />)).toMatch(/width="20" height="24"/);
  });

  it("draws Pipedrive's and Asana's marks at the symbols' height, Pipedrive's wordmark with its clear space pulled in", () => {
    // Pipedrive's app icon is drawn edge to edge, as Arc's is.
    expect(renderToStaticMarkup(<BrandMark brand="pipedrive" />)).toMatch(/width="16" height="16"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="pipedrive" size={24} />)).toMatch(/width="24" height="24"(?![^>]*style)/);
    // Pipedrive's wordmark is 820:304 with 76 clear on every side: its letters, ascender to descender, 16 px tall.
    const wordmark = renderToStaticMarkup(<BrandMark brand="pipedrive-lockup" />);
    expect(wordmark).toMatch(/width="86" height="32"/);
    expect(wordmark).toMatch(/style="margin:-8px"/);
    // Asana's logo is 112:22 and its dots fill the height: 16 px tall, the dots as tall as the symbols; 24 beside an h1.
    expect(renderToStaticMarkup(<BrandMark brand="asana-lockup" />)).toMatch(/width="81" height="16"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="asana-lockup" size={24} />)).toMatch(/width="122" height="24"(?![^>]*style)/);
  });

  it("draws Pipedrive's and Asana's files at their own proportions", () => {
    const bytes = (brand: Brand) => readFileSync(path.join(process.cwd(), "public", BRAND_FILES[brand]));
    // Pipedrive's icon is a JPEG, 200 x 200 (a frame's height, then its width, follow its marker).
    const jpegSize = (data: Buffer) => {
      expect([data[0], data[1]]).toEqual([0xff, 0xd8]);
      for (let at = 2; at < data.length; ) {
        const marker = data[at + 1];
        if (marker === 0xc0 || marker === 0xc2) return [data.readUInt16BE(at + 7), data.readUInt16BE(at + 5)];
        at += 2 + data.readUInt16BE(at + 2);
      }
      throw new Error("no frame");
    };
    expect(jpegSize(bytes("pipedrive"))).toEqual([200, 200]);
    expect(brandFile("pipedrive-lockup")).toMatch(/^<svg width="820px" height="304px" viewBox="0 0 820 304"/);
    // Asana's logo has no viewBox: its width and height are its frame, and an image scales it to the size it is drawn at.
    expect(brandFile("asana-lockup")).toMatch(/^<svg width="112" height="22" fill="none"/);
    // Its class names are Asana's website's; the file has no stylesheet for them, so its fills draw as written.
    expect(brandFile("asana-lockup")).not.toMatch(/<style|style=/);
  });

  it("takes QuickBooks' symbol from Intuit's lockup as it is: the green circle's two paths, framed by the lockup's own clip", () => {
    const symbol = brandFile("quickbooks");
    const lockup = brandFile("quickbooks-lockup");
    const paths = symbol.match(/<path[^>]*><\/path>/g) ?? [];
    expect(paths).toHaveLength(2);
    for (const drawn of paths) expect(lockup).toContain(drawn);
    // The lockup clips the circle to a 227.502 square at (0, 27.6024); the symbol's view is that square.
    expect(lockup).toContain('<clipPath id="clip0_47_724"><rect width="227.502" height="227.502" fill="white" transform="translate(0 27.6024)">');
    expect(symbol).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 27\.6024 227\.502 227\.502" fill="none">/);
    expect(symbol.replace(/<path[^>]*><\/path>/g, "")).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 27.6024 227.502 227.502" fill="none"></svg>\n');
  });

  it("is the variant for a light ground, never a white one: the site has no dark theme for a white mark to sit on", () => {
    // Every surface a mark sits on is light: the page's ground and a card's surface (src/app/globals.css). Xero's
    // midnight wordmark and HubSpot's orange sprocket are the kits' files for a light ground; their white files are
    // not shipped. QuickBooks' white "qb" is drawn on its own green circle, and the lockup's words are currentColor,
    // which an image draws in black.
    const GROUNDS = ["#f3f0e7", "#fffefa"];
    expect(fills("xero")).toEqual(Array(5).fill("#000856"));
    expect(fills("hubspot")).toEqual(["#ff4800"]);
    expect(fills("quickbooks")).toEqual(["#2ca01c", "white"]);
    expect(fills("quickbooks-lockup")).toEqual(["#2ca01c", "white", ...Array(18).fill("currentcolor")]);
    for (const [brand, colour] of [["xero", "#000856"], ["hubspot", "#ff4800"], ["quickbooks", "#2ca01c"], ["quickbooks-lockup", "#000000"]] as const) {
      // A mark is decoration beside its written name, so no contrast floor binds it; these are the owners' colours, measured.
      for (const ground of GROUNDS) expect(contrast(colour, ground), `${brand} on ${ground}`).toBeGreaterThan(2.9);
    }
    expect(contrast("#000856", "#f3f0e7")).toBeGreaterThan(15);
    // QuickBooks' green is 3.0:1 on the page's ground and 3.4:1 on a card's surface; HubSpot's orange about the same.
    expect(contrast("#2ca01c", "#fffefa")).toBeGreaterThan(3.3);
    // The white "qb" on QuickBooks' green.
    expect(contrast("#ffffff", "#2ca01c")).toBeGreaterThan(3);
  });

  it("ships Pipedrive's and Asana's marks for a light ground: the dark wordmark, the dark-lettered logo, never the white letter", () => {
    const shipped = readdirSync(path.join(process.cwd(), "public/brands"));
    // Pipedrive's wordmark draws every letter in its dark grey; its kit's white "p", for a dark ground, is not shipped.
    const uses = [...brandFile("pipedrive-lockup").matchAll(/<use [^>]*fill="(#[0-9A-Fa-f]{6})"/g)].map((match) => match[1].toLowerCase());
    expect(uses).toEqual(Array(11).fill("#26292c"));
    expect(shipped.some((file) => /pipedrive-letter/i.test(file))).toBe(false);
    // Asana's logo: "asana" in near-black, the dots in coral, on no ground of its own. The kit's dots alone come on an
    // opaque white square, which would show as a box on the page's cream ground: not shipped.
    expect(fills("asana-lockup")).toEqual(["#0d0e10", "#f06a6a"]);
    expect(brandFile("asana-lockup")).not.toMatch(/<rect/);
    expect(shipped.filter((file) => file.startsWith("asana"))).toEqual(["asana-lockup.svg"]);
    const GROUNDS = ["#f3f0e7", "#fffefa"];
    for (const ground of GROUNDS) {
      expect(contrast("#26292c", ground), `Pipedrive's wordmark on ${ground}`).toBeGreaterThan(12);
      expect(contrast("#0d0e10", ground), `Asana's letters on ${ground}`).toBeGreaterThan(16);
      // The coral dots are decoration beside the name, so no contrast floor binds them: Asana's colour, measured.
      expect(contrast("#f06a6a", ground), `Asana's dots on ${ground}`).toBeGreaterThan(2.6);
    }
    // Pipedrive's icon carries its own ground: the white "p" on its green.
    expect(contrast("#ffffff", "#007737")).toBeGreaterThan(5.5);
  });

  it("exists only for services the code integrates with: no Gmail, whose inbox is reached by forwarding", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/vx/BrandMarks.tsx"), "utf8");
    expect(source).not.toMatch(/gmail|google/i);
    expect(readdirSync(path.join(process.cwd(), "public/brands")).sort()).toEqual([
      "arc.jpeg",
      "asana-lockup.svg",
      "circle.svg",
      "hubspot.svg",
      "npm.svg",
      "pipedrive-lockup.svg",
      "pipedrive.jpeg",
      "quickbooks-lockup.svg",
      "quickbooks.svg",
      "slack.svg",
      "telegram.svg",
      "xero.svg",
    ]);
  });

  it("gives each connector its own mark, and Intuit's name alone no mark: no place stands for Intuit itself", () => {
    expect(Object.keys(PROVIDER_MARKS).sort()).toEqual([...PROVIDERS].sort());
    expect(PROVIDER_MARKS).toEqual({ xero: "xero", quickbooks: "quickbooks", hubspot: "hubspot", pipedrive: "pipedrive", asana: "asana-lockup" });
    // A connector's mark is a symbol before its written name, but Xero's wordmark and Asana's logo, which spell theirs.
    for (const provider of PROVIDERS) expect(isWordmark(PROVIDER_MARKS[provider]), provider).toBe(provider === "xero" || provider === "asana");
    expect(readdirSync(path.join(process.cwd(), "public/brands")).some((file) => /^intuit/i.test(file))).toBe(false);
  });

  it("is used nowhere without its name beside it", () => {
    // Every file that draws a mark also writes the brand's name.
    const NAMES: Record<Brand, string> = {
      arc: "Arc",
      circle: "Circle",
      slack: "Slack",
      telegram: "Telegram",
      npm: "npm",
      xero: "Xero",
      quickbooks: "QuickBooks",
      "quickbooks-lockup": "QuickBooks",
      hubspot: "HubSpot",
      pipedrive: "Pipedrive",
      "pipedrive-lockup": "Pipedrive",
      "asana-lockup": "Asana",
    };
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    const users = walk(path.join(process.cwd(), "src")).filter((file) => file.endsWith(".tsx") && !file.endsWith("BrandMarks.tsx"));
    for (const file of users) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<Brand(?:Mark|Name) brand="([\w-]+)"/g)) expect(source, file).toContain(NAMES[match[1] as Brand]);
      // A connector's mark is drawn where its name is: the file writes the provider's label.
      if (source.includes("PROVIDER_MARKS[")) expect(source, file).toContain("PROVIDER_LABELS[provider]");
    }
  });

  it("knows npm's and Xero's marks and the QuickBooks, Pipedrive and Asana lockups spell their names, and the symbols do not", () => {
    expect(BRANDS.filter(isWordmark)).toEqual(["npm", "xero", "quickbooks-lockup", "pipedrive-lockup", "asana-lockup"]);
  });

  it("names a mark beside its name: a wordmark stands in its place with the name for screen readers, any other before it", () => {
    const xero = renderToStaticMarkup(<BrandName brand="xero" name="Xero" />);
    expect(xero).toMatch(/<img src="\/brands\/xero\.svg" alt="" aria-hidden="true"[^>]*\/><span class="sr-only">Xero<\/span>/);
    const quickbooks = renderToStaticMarkup(<BrandName brand="quickbooks" name="QuickBooks" />);
    expect(quickbooks).toMatch(/<img src="\/brands\/quickbooks\.svg" alt="" aria-hidden="true"[^>]*\/><span>QuickBooks<\/span>/);
    const hubspot = renderToStaticMarkup(<BrandName brand="hubspot" name="HubSpot" size={24} />);
    expect(hubspot).toMatch(/<img src="\/brands\/hubspot\.svg" alt="" aria-hidden="true"[^>]*width="20" height="24"[^>]*\/><span>HubSpot<\/span>/);
    const pipedrive = renderToStaticMarkup(<BrandName brand="pipedrive" name="Pipedrive" />);
    expect(pipedrive).toMatch(/<img src="\/brands\/pipedrive\.jpeg" alt="" aria-hidden="true"[^>]*\/><span>Pipedrive<\/span>/);
    const lockup = renderToStaticMarkup(<BrandName brand="asana-lockup" name="Asana" />);
    expect(lockup).toMatch(/<img src="\/brands\/asana-lockup\.svg" alt="" aria-hidden="true"[^>]*\/><span class="sr-only">Asana<\/span>/);
  });
});

describe("the landing page's built on and works with", () => {
  const markup = renderToStaticMarkup(<BuiltWith />);

  it("names each service beside its mark, and links to the evidence, Arc and Circle to their own sites as well", () => {
    const page = text(markup);
    for (const name of ["Arc", "Circle", "Xero", "QuickBooks Online", "HubSpot", "Pipedrive", "Asana", "Slack", "Telegram", "npm"]) expect(page).toContain(name);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([
      "/open",
      "https://www.arc.io",
      "https://github.com/duongnq2798/vestiarion/blob/main/src/lib/circle/liveProvider.ts",
      "https://www.circle.com",
      "/docs/guides/xero",
      "/docs/guides/quickbooks",
      "/docs/guides/hubspot",
      "/docs/guides/pipedrive",
      "/docs/guides/asana",
      "/docs/guides/slack",
      "/docs/guides/telegram",
      "/docs/get-started/sdk",
    ]);
    expect([...markup.matchAll(/data-brand="([\w-]+)"/g)].map((match) => match[1])).toEqual([
      "arc",
      "circle",
      "xero",
      "quickbooks-lockup",
      "hubspot",
      "pipedrive-lockup",
      "asana-lockup",
      "slack",
      "telegram",
      "npm",
    ]);
    // npm's and Xero's marks and the QuickBooks, Pipedrive and Asana lockups are their names, so the written names are
    // for screen readers.
    expect(markup).toContain('<span class="sr-only">npm</span>');
    expect(markup).toContain('<span class="sr-only">Xero</span>');
    expect(markup).toMatch(/data-brand="quickbooks-lockup"[^>]*\/><span class="sr-only">QuickBooks Online<\/span>/);
    expect(markup).toMatch(/data-brand="pipedrive-lockup"[^>]*\/><span class="sr-only">Pipedrive<\/span>/);
    expect(markup).toMatch(/data-brand="asana-lockup"[^>]*\/><span class="sr-only">Asana<\/span>/);
    // Every service shows its mark: none is named in words alone.
    expect(markup).not.toMatch(/font-semibold text-ink"><span>/);
  });

  it("lists ten services, two to a row below a laptop's width and five from it, so every row is full", () => {
    const items = [...markup.matchAll(/<li class="([^"]*)"/g)].map((match) => match[1]);
    expect(items).toHaveLength(10);
    expect(markup).toContain('<ul class="grid grid-cols-2 lg:grid-cols-5">');
    expect(markup).not.toMatch(/grid-cols-(3|4)/);
    // Five to a row: the first of each row starts without a rule, and the rows after the first have one above them.
    for (const item of items) expect(item).toContain("lg:nth-[5n+1]:border-l-0");
    for (const item of items) expect(item).toContain("lg:nth-[n+6]:border-t");
    // Ten fill every row of two and of five: none spans.
    for (const item of items) expect(item).not.toMatch(/col-span/);
    // A name too long for a phone's half width moves under its mark instead of running into the line below.
    expect(markup).toContain("min-h-5 flex-wrap");
    expect(markup).not.toMatch(/flex h-5 /);
  });

  it("says what each new integration does, each with its guide", () => {
    const page = text(markup);
    expect(page).toContain("Bills come in for review; payments on Arc are booked back once approved. Read the guide");
    // The lockup says QuickBooks; the words say which one.
    expect(page).toContain("Open bills from QuickBooks Online come in for review, sooner via webhooks. Read the guide");
    expect(page).toContain("Won deals come in with their customers, to plan as collection schedules; what each collected goes back to the deal. Read the guide");
  });

  it("says built on and works with, never that a service vouches for Vestiarion", () => {
    const page = text(markup).toLowerCase();
    expect(page).toContain("built on, and works with");
    for (const claim of ["partner", "trusted by", "powered by", "endorsed by", "certified", "gmail"]) expect(page).not.toContain(claim);
    // The trademark notice npm's policy asks for, Intuit's owner named, and that the marks are not an endorsement.
    expect(page).toContain("npm is a registered trademark of npm, inc.");
    expect(page).toContain("intuit and quickbooks are trademarks of intuit inc.");
    expect(page).toContain("arc, circle, slack, telegram, xero, hubspot, pipedrive and asana are trademarks of their respective owners.");
    expect(page).toContain("not an endorsement");
  });
});

describe("the landing page's answer to how bills come in", () => {
  it("names the bill list, Xero, QuickBooks Online, HubSpot and Pipedrive beside the form, PDF, email, Telegram and the API", async () => {
    const { landingFaq } = await import("@/components/landing/Faq");
    const answer = landingFaq(true).find((entry) => entry.question === "Does it fit how we already work?")?.answer;
    expect(typeof answer).toBe("string");
    for (const way of ["form", "PDF", "a bill list from your spreadsheet", "email", "Telegram", "the API", "Xero", "QuickBooks Online", "HubSpot", "Pipedrive"]) {
      expect(answer).toContain(way);
    }
    expect(answer).toContain("Won deals come in from HubSpot or Pipedrive to plan their collections.");
    expect(answer).toContain("Contractor work delivered in Asana is paid once a person accepts it against its criteria.");
  });
});
