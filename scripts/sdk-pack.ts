import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Builds the TypeScript SDK and packs it into public/sdk/vestiarion-sdk-<version>.tgz, the tarball
 * https://www.vestiarion.xyz/sdk/ serves (TypeScript SDK design R2). Run after changing sdk/ and its version:
 *
 *   npm run sdk:pack
 *
 * A version already packed is never packed again: its URL may sit in someone's lockfile, with the hash of its bytes.
 * tests/sdk-package.test.ts fails while the committed tarball is not what sdk/ builds.
 */
const root = path.resolve(import.meta.dirname, "..");
const sdk = path.join(root, "sdk");
const { version } = JSON.parse(readFileSync(path.join(sdk, "package.json"), "utf8")) as { version: string };
const destination = path.join(root, "public", "sdk");
const tarball = path.join(destination, `vestiarion-sdk-${version}.tgz`);
if (existsSync(tarball)) {
  console.error(`${path.relative(root, tarball)} exists. Bump sdk/package.json's version (and VERSION) to pack another.`);
  process.exit(1);
}
rmSync(path.join(sdk, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(sdk, "tsconfig.json")], { stdio: "inherit" });
mkdirSync(destination, { recursive: true });
execFileSync("npm", ["pack", sdk, "--pack-destination", destination], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`wrote ${path.relative(root, tarball)}`);
