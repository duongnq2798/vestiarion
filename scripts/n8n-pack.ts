import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Builds the n8n node package with n8n's own tooling and packs it into
 * public/n8n/vestiarion-n8n-nodes-vestiarion-<version>.tgz: the file an owner of the npm organization publishes, and
 * https://www.vestiarion.xyz/n8n/ serves (docs/superpowers/specs/2026-11-03-n8n-node-design.md N10). Run after
 * `npm ci --prefix n8n`, and after changing n8n/ and its version:
 *
 *   npm run n8n:pack
 *
 * A version already packed is never packed again: its bytes may already be on npm, or in someone's n8n.
 * n8n/test/package.test.ts fails while the committed tarball is not what n8n/ builds.
 */
const root = path.resolve(import.meta.dirname, "..");
const pkgDir = path.join(root, "n8n");
const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string };
const destination = path.join(root, "public", "n8n");
const tarball = path.join(destination, `vestiarion-n8n-nodes-vestiarion-${version}.tgz`);
if (existsSync(tarball)) {
  console.error(`${path.relative(root, tarball)} exists. Bump n8n/package.json's version to pack another.`);
  process.exit(1);
}
const npm = (args: string[]) => execFileSync("npm", args, { cwd: pkgDir, stdio: "inherit", shell: process.platform === "win32" });
npm(["run", "build"]);
mkdirSync(destination, { recursive: true });
npm(["pack", "--pack-destination", destination]);
console.log(`wrote ${path.relative(root, tarball)}`);
