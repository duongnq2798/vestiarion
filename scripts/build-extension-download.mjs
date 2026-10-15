#!/usr/bin/env node
/**
 * Builds the downloadable copy of Vestiarion Invoice Capture, `public/downloads/vestiarion-invoice-capture.zip`, from
 * `extensions/chrome-invoice-capture/extension`: the same files, with the public key of
 * `src/lib/extension/download-key.json` added to its manifest as `key`. An unpacked extension's ID is otherwise worked
 * out from the folder it is loaded from, so every copy would have its own and none could connect; with the key, every
 * copy has the one ID the deployment allows (`DOWNLOAD_EXTENSION_ID`). The Chrome Web Store refuses a manifest with
 * `key`, so the package's own manifest has none, and the store's copy keeps the ID the store gives it.
 *
 * The zip stores its files uncompressed, in path order, with a fixed date, so the same files always give the same
 * bytes: `tests/extension-download.test.ts` builds it again and compares it with the file committed. After changing
 * the extension, run `npm run extension:download` and commit the zip.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = path.join(ROOT, "extensions", "chrome-invoice-capture", "extension");
const KEY_FILE = path.join(ROOT, "src", "lib", "extension", "download-key.json");
export const DOWNLOAD_PATH = path.join(ROOT, "public", "downloads", "vestiarion-invoice-capture.zip");

/** Every file of the package, as zip paths with forward slashes, in order. */
function packageFiles(dir = PACKAGE, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const name = prefix + entry.name;
      return entry.isDirectory() ? packageFiles(path.join(dir, entry.name), `${name}/`) : [name];
    });
}

/** The package's manifest with the download's public key, as the extension reads it. */
export function downloadManifest() {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE, "manifest.json"), "utf8"));
  const { key } = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  return `${JSON.stringify({ ...manifest, key }, null, 2)}\n`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the earliest date a zip can hold, so a rebuild gives the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** The zip's bytes: each file stored as it is, its manifest with the key. */
export function buildDownloadZip() {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of packageFiles()) {
    const data = name === "manifest.json" ? Buffer.from(downloadManifest(), "utf8") : readFileSync(path.join(PACKAGE, ...name.split("/")));
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, fileName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const count = centrals.length / 2;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(path.dirname(DOWNLOAD_PATH), { recursive: true });
  const zip = buildDownloadZip();
  writeFileSync(DOWNLOAD_PATH, zip);
  console.log(`${path.relative(ROOT, DOWNLOAD_PATH)}: ${zip.length} bytes`);
}
