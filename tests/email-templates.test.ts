import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Supabase auth email templates, kept in supabase/templates/ and pasted
 * into the dashboard. They are Go templates, so these tests render them with
 * sample values and check what a recipient would actually get.
 *
 * The first production email went to spam partly because its link pointed at
 * <project>.supabase.co while it was sent from vestiarion.xyz. Every link and
 * image here must come from the site itself.
 */

const DIR = path.join(process.cwd(), "supabase", "templates");
const TEMPLATES = ["magic-link.html", "confirm-signup.html"];
const SITE = "https://www.vestiarion.xyz";
const SAMPLE: Record<string, string> = { SiteURL: SITE, TokenHash: "pkce_0123456789abcdef", Email: "owner@example.com" };
const CONFIRM = `${SITE}/auth/confirm?token_hash=pkce_0123456789abcdef&type=email`;

function render(template: string): string {
  return template.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_match, name: string) => SAMPLE[name] ?? `__UNKNOWN_VARIABLE_${name}__`);
}

function attributes(html: string, attribute: "href" | "src"): string[] {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map((match) => match[1].replace(/&amp;/g, "&"));
}

describe.each(TEMPLATES)("%s", (file) => {
  const html = render(readFileSync(path.join(DIR, file), "utf8"));

  it("links to this site's /auth/confirm with the token hash", () => {
    expect(attributes(html, "href")).toContain(CONFIRM);
  });

  it("never links or loads anything from another host", () => {
    for (const url of [...attributes(html, "href"), ...attributes(html, "src")]) {
      if (/^https?:/.test(url)) expect(url.startsWith(`${SITE}/`) || url === SITE, url).toBe(true);
    }
    expect(html).not.toContain("supabase.co");
  });

  it("uses only variables Supabase provides, and never the third-party ConfirmationURL", () => {
    expect(html).not.toContain("__UNKNOWN_VARIABLE_");
  });

  it("loads the logo from this site as a PNG, since email clients do not render SVG", () => {
    expect(attributes(html, "src")).toContain(`${SITE}/email/logo.png`);
  });

  it("also prints the link as text, for clients that block buttons", () => {
    const visible = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
    expect(visible).toContain(CONFIRM);
  });

  it("names the address it was sent to, so a stray email is recognisable as one", () => {
    expect(html).toContain("owner@example.com");
  });
});

describe("the logo file the templates load", () => {
  it("is a 96×96 PNG", () => {
    const png = readFileSync(path.join(process.cwd(), "public", "email", "logo.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(96);
  });
});
