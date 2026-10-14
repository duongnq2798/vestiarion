import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Builds the CLI and packs it into public/cli/vestiarion-cli-<version>.tgz: the file an owner of the npm organization
 * publishes, and https://www.vestiarion.xyz/cli/ serves. Run after changing cli/ and its version:
 *
 *   npm run cli:pack
 *
 * A version already packed is never packed again: its bytes may already be on npm, or in someone's lockfile.
 * tests/cli-package.test.ts fails while the committed tarball is not what cli/ builds.
 */
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "cli");
const { version } = JSON.parse(readFileSync(path.join(cli, "package.json"), "utf8")) as { version: string };
const destination = path.join(root, "public", "cli");
const tarball = path.join(destination, `vestiarion-cli-${version}.tgz`);
if (existsSync(tarball)) {
  console.error(`${path.relative(root, tarball)} exists. Bump cli/package.json's version (and VERSION) to pack another.`);
  process.exit(1);
}
rmSync(path.join(cli, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(cli, "tsconfig.json")], { stdio: "inherit" });
mkdirSync(destination, { recursive: true });
execFileSync("npm", ["pack", cli, "--pack-destination", destination], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`wrote ${path.relative(root, tarball)}`);
