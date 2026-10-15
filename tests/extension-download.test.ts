import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildDownloadZip, DOWNLOAD_PATH, downloadManifest } from "../scripts/build-extension-download.mjs";
import downloadKey from "@/lib/extension/download-key.json";
import { DOWNLOAD_EXTENSION_ID, isExtensionId } from "@/lib/extension/settings";

/**
 * The copy of Vestiarion Invoice Capture offered for download (`/downloads/vestiarion-invoice-capture.zip`): the
 * package's own files, its manifest with a public key that gives every copy one ID, the ID the deployment allows.
 */

const ROOT = path.resolve(__dirname, "..");
const PACKAGE = path.join(ROOT, "extensions", "chrome-invoice-capture", "extension");

/** Chrome's ID for a key: the first 16 bytes of the SHA-256 of the key's DER, each hex digit as a letter from a to p. */
function idOfKey(base64: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

/** The entries of a zip, read from its central directory. */
function entries(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const found = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(start, start + size);
    found.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLength + extra;
  }
  return found;
}

describe("the extension offered for download", () => {
  it("has the one ID its manifest's key gives it, and the deployment allows that ID", () => {
    expect(isExtensionId(DOWNLOAD_EXTENSION_ID)).toBe(true);
    expect(idOfKey(downloadKey.key)).toBe(downloadKey.id);
    expect(DOWNLOAD_EXTENSION_ID).toBe(downloadKey.id);
  });

  it("is the package as it is now: run `npm run extension:download` and commit the zip after changing the extension", () => {
    const committed = readFileSync(DOWNLOAD_PATH);
    expect(committed.equals(buildDownloadZip()), "public/downloads/vestiarion-invoice-capture.zip is out of date").toBe(true);
  });

  it("holds every file of the package at its root, with forward slashes, and the manifest with the key alone added", () => {
    const zip = entries(readFileSync(DOWNLOAD_PATH));
    expect(zip.has("manifest.json")).toBe(true);
    for (const name of zip.keys()) expect(name, name).not.toContain("\\");
    const packageManifest = JSON.parse(readFileSync(path.join(PACKAGE, "manifest.json"), "utf8"));
    // The package's own manifest has no key: the Chrome Web Store refuses one, and gives its copy its own ID.
    expect(packageManifest).not.toHaveProperty("key");
    const manifest = JSON.parse(zip.get("manifest.json")!.toString("utf8"));
    expect(manifest).toEqual({ ...packageManifest, key: downloadKey.key });
    expect(downloadManifest()).toBe(zip.get("manifest.json")!.toString("utf8"));
    for (const name of ["background.js", "popup.html", "popup.js", "popup.css", "lib/api.js", "icons/icon-128.png"]) {
      expect(zip.get(name)?.equals(readFileSync(path.join(PACKAGE, ...name.split("/")))), name).toBe(true);
    }
  });
});
