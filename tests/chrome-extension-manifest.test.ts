import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MISSING_WORDS } from "@/lib/invoice-drafts/model";

/**
 * Vestiarion Invoice Capture as it ships (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C23-C26): a
 * Manifest V3 extension asking for exactly the six permissions its listing justifies and no host at all (its calls to
 * Vestiarion rely on the CORS Vestiarion answers it), with every line of code in the package (no remote code, no eval,
 * no CDN), nothing sent anywhere but Vestiarion and never with cookies, no analytics, nothing from a page or a
 * document written as markup, and a packing command that leaves no file behind.
 */

const ROOT = path.join(process.cwd(), "extensions", "chrome-invoice-capture");
const PACKAGE = path.join(ROOT, "extension");
const manifest = JSON.parse(readFileSync(path.join(PACKAGE, "manifest.json"), "utf8")) as Record<string, unknown>;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const FILES = walk(PACKAGE);
const CODE = FILES.filter((file) => /\.(js|mjs|html|css|json)$/.test(file)).map((file) => ({ file: path.relative(PACKAGE, file).split(path.sep).join("/"), text: readFileSync(file, "utf8") }));
const SCRIPTS = CODE.filter(({ file }) => file.endsWith(".js"));

describe("the manifest (C23)", () => {
  it("is Manifest V3, with exactly the six permissions and no host", () => {
    expect(manifest.manifest_version).toBe(3);
    // `alarms` drops a selection from the context menu after 5 minutes; it shows no warning at install.
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage", "identity", "contextMenus", "alarms"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  it("runs nothing on pages by itself, opens itself to no other site or extension, and keeps MV3's own content security policy", () => {
    for (const key of ["content_scripts", "externally_connectable", "web_accessible_resources", "content_security_policy", "sandbox", "update_url", "key"]) {
      expect(manifest, key).not.toHaveProperty(key);
    }
  });

  it("names its single purpose: capturing invoices into Vestiarion", () => {
    expect(manifest.name).toBe("Vestiarion Invoice Capture");
    expect(String(manifest.description).length).toBeLessThanOrEqual(132);
  });

  it("ships every file it names", () => {
    const named = [
      (manifest.action as { default_popup: string }).default_popup,
      (manifest.background as { service_worker: string }).service_worker,
      ...Object.values(manifest.icons as Record<string, string>),
      ...Object.values((manifest.action as { default_icon: Record<string, string> }).default_icon),
    ];
    for (const file of named) expect(existsSync(path.join(PACKAGE, file)), file).toBe(true);
    for (const size of ["16", "32", "48", "128"]) expect((manifest.icons as Record<string, string>)[size]).toBe(`icons/icon-${size}.png`);
  });
});

describe("the code (C23-C25)", () => {
  it("has no eval, no code built from strings and no remote code", () => {
    for (const { file, text } of SCRIPTS) {
      expect(text, file).not.toMatch(/\beval\s*\(/);
      expect(text, file).not.toMatch(/new\s+Function\s*\(/);
      expect(text, file).not.toMatch(/set(?:Timeout|Interval)\s*\(\s*["'`]/);
      expect(text, file).not.toMatch(/import\s*\(\s*["'`]https?:/);
      expect(text, file).not.toMatch(/from\s+["']https?:/);
      expect(text, file).not.toMatch(/importScripts/);
    }
    for (const { file, text } of CODE.filter(({ file }) => file.endsWith(".html"))) {
      expect(text, file).not.toMatch(/<script(?![^>]*\bsrc="(?!https?:)[^"]+")[^>]*>/);
      expect(text, file).not.toMatch(/\son[a-z]+="/);
      expect(text, file).not.toMatch(/(?:src|href)="https?:/);
    }
  });

  it("sends to Vestiarion alone: the one address is the configured one", () => {
    const addresses = SCRIPTS.flatMap(({ file, text }) => [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((match) => `${file}: ${match[0]}`));
    expect(addresses).toEqual(["lib/config.js: https://www.vestiarion.xyz"]);
    for (const { file, text } of SCRIPTS) {
      for (const call of text.matchAll(/fetch\(\s*([^,)]+)/g)) expect(`${file}: ${call[1]}`).toMatch(/: (?:url|TOKEN_URL|REVOKE_URL)$/);
      // No cookie goes with a call: the token is the only credential.
      expect(text, file).not.toMatch(/credentials\s*:/);
    }
  });

  it("keeps the access token in memory and only the refresh token on disk, and keeps both from content scripts", () => {
    const auth = CODE.find(({ file }) => file === "lib/auth.js")!.text;
    expect(auth).toContain("chrome.storage.session.set({ access:");
    expect(auth).not.toMatch(/storage\.local\.set\(\{[^}]*accessToken/);
    const background = CODE.find(({ file }) => file === "background.js")!.text;
    expect(background).toContain('setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })');
  });

  it("counts nothing: no analytics, no error reporting service", () => {
    for (const { file, text } of CODE) {
      expect(text, file).not.toMatch(/google-analytics|googletagmanager|gtag\(|posthog|segment\.(?:io|com)|mixpanel|amplitude|sentry|plausible|datadog/i);
    }
  });

  it("writes what comes from a page or a document as text, never as markup", () => {
    for (const { file, text } of SCRIPTS) {
      expect(text, file).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
    }
  });

  it("reads a page only through the selection, on a person's click", () => {
    const selection = CODE.find(({ file }) => file === "lib/selection.js")!.text;
    expect(selection).toContain("globalThis.getSelection");
    const executes = SCRIPTS.flatMap(({ file, text }) => (text.includes("executeScript") ? [file] : []));
    expect(executes).toEqual(["lib/selection.js"]);
    // Every script it runs is the one function that returns the selection's text.
    for (const call of selection.matchAll(/executeScript\(\{[^}]*\}[^)]*func:\s*(\w+)/g)) expect(call[1]).toBe("selectedText");
  });

  it("says what is missing in Vestiarion's own words", async () => {
    const fields = await import("../extensions/chrome-invoice-capture/extension/lib/fields.js");
    expect(fields.MISSING_WORDS).toEqual(MISSING_WORDS);
  });
});

describe("the store listing (C26)", () => {
  const listing = readFileSync(path.join(ROOT, "STORE_LISTING.md"), "utf8");

  it("justifies each permission the manifest asks for, and says it asks for no host", () => {
    for (const permission of manifest.permissions as string[]) expect(listing, permission).toContain(`\`${permission}\``);
    expect(listing).toContain("Host permissions: none.");
  });

  it("says what the extension does not do, its single purpose and its privacy answers", () => {
    expect(listing).toContain("## What it does not do");
    expect(listing).toContain("## Single purpose");
    expect(listing).toContain("## Privacy");
    expect(listing).toContain(String(manifest.name));
  });
});

describe("packing it (README)", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const command = /^tar\.exe -a -c -f (\S+\.zip) -C extensions\/chrome-invoice-capture\/extension (.+)$/m.exec(readme);

  it("zips with tar, whose entries keep forward slashes, as the Chrome Web Store needs", () => {
    expect(command, "the README's tar command").not.toBeNull();
    expect(readme).not.toMatch(/^Compress-Archive /m);
  });

  it("names every file and folder of the package, and nothing else", () => {
    const named = command![2].trim().split(/\s+/).sort();
    expect(named).toEqual(readdirSync(PACKAGE).sort());
  });
});
