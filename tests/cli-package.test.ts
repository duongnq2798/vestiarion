import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import crypto from "node:crypto";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { VERSION } from "../cli/src/version";

/** The CLI as a package: what npm publishes from public/cli/, and that it runs from there, as a bin and through npx. */

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync("cli/package.json", "utf8")) as Record<string, unknown> & { version: string; dependencies: Record<string, string> };
const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies: Record<string, string> };
const TARBALL = path.join(ROOT, "public", "cli", `vestiarion-cli-${pkg.version}.tgz`);
/** The SDK the CLI is built and tested against: the one installed for this repository, whose tarball the site serves. */
const SDK_VERSION = (JSON.parse(readFileSync("node_modules/@vestiarion/sdk/package.json", "utf8")) as { version: string }).version;
const SDK_TARBALL = path.join(ROOT, "public", "sdk", `vestiarion-sdk-${SDK_VERSION}.tgz`);

/** The files in a .tgz, by path. A tar file is 512-byte headers, each followed by its file padded to 512 bytes. */
function untar(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  const field = (from: number, to: number, header: Buffer) => header.subarray(from, to).toString("utf8").replace(/\0[\s\S]*$/, "");
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = field(0, 100, header);
    if (!name) break;
    const prefix = field(345, 500, header);
    const size = parseInt(field(124, 136, header).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0") files.set(prefix ? `${prefix}/${name}` : name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Unpacks a package tarball into `dir`, as npm would install it there. */
function unpack(tgz: string, dir: string) {
  for (const [file, bytes] of untar(readFileSync(tgz))) {
    const target = path.join(dir, file.replace(/^package\//, ""));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

/** What `tsc -p cli` emits, by path under cli/, built in memory. */
function buildCli(): Map<string, string> {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve("cli/tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error("cli/tsconfig.json could not be read");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const out = new Map<string, string>();
  const emitted = program.emit(undefined, (fileName, text) => out.set(path.relative(path.resolve("cli"), fileName).replaceAll("\\", "/"), text));
  const problems = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (problems.length > 0) throw new Error(ts.formatDiagnostics(problems, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  return out;
}

const lf = (text: string | undefined) => text?.replace(/\r\n/g, "\n");

/** An environment with no key, no profile and no saved config: what a fresh machine has. */
function freshEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "roaming"), XDG_CONFIG_HOME: path.join(home, "xdg") };
  for (const name of Object.keys(env)) if (name.startsWith("VESTIARION_")) delete env[name];
  return env;
}

describe("the CLI package", () => {
  it("states its version once: VERSION is package.json's", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is an ESM package for Node 20 or later, with the vestiarion bin and the SDK as its one dependency", () => {
    expect(pkg).toMatchObject({
      name: "@vestiarion/cli",
      type: "module",
      license: "MIT",
      engines: { node: ">=20" },
      bin: { vestiarion: "dist/bin.js" },
      files: ["dist", "README.md", "LICENSE"],
    });
    expect(Object.keys(pkg.dependencies)).toEqual(["@vestiarion/sdk"]);
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("is built and tested against the SDK range it depends on, as npm serves it", () => {
    expect(rootPkg.devDependencies["@vestiarion/sdk"]).toBe(pkg.dependencies["@vestiarion/sdk"]);
  });

  it("imports only Node's own modules, its own files and the SDK", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    const sources = walk("cli/src");
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      for (const [, from] of readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)) {
        expect(from.startsWith("node:") || from.startsWith("./") || from.startsWith("../") || from === "@vestiarion/sdk", `${file}: ${from}`).toBe(true);
      }
    }
  });
});

describe("the tarball npm publishes", () => {
  it("holds, for this version, exactly what cli/ builds, its package.json, README and licence: run npm run cli:pack", () => {
    const files = untar(readFileSync(TARBALL));
    const expected = new Map([...buildCli()].map(([file, text]) => [`package/${file}`, text]));
    expected.set("package/README.md", readFileSync("cli/README.md", "utf8"));
    expected.set("package/LICENSE", readFileSync("cli/LICENSE", "utf8"));
    expect([...files.keys()].sort()).toEqual([...expected.keys(), "package/package.json"].sort());
    for (const [file, text] of expected) expect(lf(files.get(file)?.toString("utf8")), file).toBe(lf(text));
    expect(JSON.parse(files.get("package/package.json")!.toString("utf8"))).toEqual(pkg);
    expect(files.get("package/dist/bin.js")!.toString("utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs from the unpacked tarball beside the SDK's: help, version, an auth error without a key, and an offline check", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vestiarion-cli-bin-"));
    const modules = path.join(home, "node_modules", "@vestiarion");
    unpack(TARBALL, path.join(modules, "cli"));
    unpack(SDK_TARBALL, path.join(modules, "sdk"));
    const bin = path.join(modules, "cli", "dist", "bin.js");
    const options: SpawnSyncOptions = { cwd: home, env: freshEnv(home), encoding: "utf8" };
    const vestiarion = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], options) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };

    const help = vestiarion("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: vestiarion <command> [options]");
    expect(vestiarion("--version").stdout).toBe(`${pkg.version}\n`);

    const whoami = vestiarion("whoami");
    expect(whoami.status).toBe(3);
    expect(whoami.stderr).toContain("No API key");

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const bodyHash = crypto.createHash("sha256").update('{"action":"seed","actor":"system","detail":{},"domain":"system","summary":"Seeded"}').digest("hex");
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
    const hash = crypto.createHash("sha256").update("0".repeat(64) + bodyHash + signature).digest("hex");
    const entry = { seq: 1, id: "e-1", ts: "2026-10-14T00:00:00Z", actor: "system", domain: "system", action: "seed", summary: "Seeded", detail: {}, body_hash: bodyHash, signature, prev_hash: "0".repeat(64), hash, signing_key_id: null };
    const exportFile = path.join(home, "export.json");
    writeFileSync(exportFile, JSON.stringify({ format: "vestiarion-ledger-export/1", workspace: { slug: "packed" }, head: { seq: 1, hash }, keys: [{ publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }], entries: [entry] }));
    const verified = vestiarion("ledger", "verify", exportFile);
    expect(verified.stderr).toBe("");
    expect(verified.stdout).toMatch(/^VALID: 1 entries of packed/);
    expect(verified.status).toBe(0);
  }, 60_000);

  it(
    "prints its help through npx, from the tarball alone, with no network",
    () => {
      const home = mkdtempSync(path.join(tmpdir(), "vestiarion-cli-npx-"));
      const args = ["exec", "--yes", "--offline", "--cache", path.join(home, "npm-cache"), "--package", TARBALL, "--package", SDK_TARBALL, "--", "vestiarion", "--help"];
      // npm's own script when the tests run under npm; else the npm on PATH, which Windows runs through its shell.
      const npmCli = process.env.npm_execpath?.endsWith("npm-cli.js") ? process.env.npm_execpath : undefined;
      const options: SpawnSyncOptions = { cwd: home, env: freshEnv(home), encoding: "utf8", timeout: 120_000 };
      const result = npmCli
        ? spawnSync(process.execPath, [npmCli, ...args], options)
        : spawnSync("npm", args.map((arg) => (process.platform === "win32" ? `"${arg}"` : arg)), { ...options, shell: process.platform === "win32" });
      expect(result.stderr?.toString() ?? "", "npm's own output").not.toMatch(/ERR!/);
      expect(result.status).toBe(0);
      expect(result.stdout?.toString()).toContain("Usage: vestiarion <command> [options]");
    },
    150_000
  );

  it("is served as a download, not sniffed by the browser", async () => {
    expect(await nextConfig.headers!()).toContainEqual({
      source: "/cli/:path*",
      headers: [
        { key: "Content-Disposition", value: "attachment" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    });
  });
});

describe("the docs", () => {
  it.each([
    ["the docs page", "content/docs/get-started/cli.mdx"],
    ["the README", "cli/README.md"],
  ])("%s installs from npm first, and names this version's tarball on the site", (_label, file) => {
    const text = readFileSync(file, "utf8");
    expect(text.indexOf("npm install --global @vestiarion/cli")).toBeGreaterThanOrEqual(0);
    expect(text).toContain(`https://www.vestiarion.xyz/cli/vestiarion-cli-${pkg.version}.tgz`);
    expect(text.indexOf("npm install --global @vestiarion/cli")).toBeLessThan(text.indexOf(`vestiarion-cli-${pkg.version}.tgz`));
  });

  it.each([
    ["the docs page", "content/docs/get-started/cli.mdx"],
    ["the README", "cli/README.md"],
    ["the repository README", "README.md"],
  ])("%s runs only commands the CLI has", async (_label, file) => {
    const { COMMANDS } = await import("../cli/src/main");
    const names = new Set(COMMANDS.map((command) => command.path.join(" ")));
    const text = readFileSync(file, "utf8");
    // Every command line in a code block, and every inline code span, that starts with the command.
    const invocations = [
      ...[...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap(([, block]) => block.split("\n")),
      ...[...text.matchAll(/`(vestiarion [^`]+)`/g)].map(([, code]) => code),
    ]
      .map((line) => line.trim())
      .filter((line) => line.startsWith("vestiarion "));
    expect(invocations.length).toBeGreaterThan(2);
    for (const line of invocations) {
      const [, first, second] = line.split(/\s+/);
      if (first.startsWith("-") || first.startsWith("<")) continue;
      expect(names.has(first) || names.has(`${first} ${second}`), line).toBe(true);
    }
  });
});
