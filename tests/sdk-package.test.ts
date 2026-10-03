import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { VERSION } from "../sdk/src/version";

/** The TypeScript SDK as a package (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R1, R2). */

const pkg = JSON.parse(readFileSync("sdk/package.json", "utf8")) as Record<string, unknown>;

describe("the SDK package", () => {
  it("states its version once: VERSION is package.json's", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is an ESM package for Node 20 or later, with no runtime dependencies", () => {
    expect(pkg).toMatchObject({ name: "@vestiarion/sdk", type: "module", license: "MIT", engines: { node: ">=20" } });
    expect(pkg.dependencies).toBeUndefined();
  });

  it("uses fetch and Web Crypto only: nothing in sdk/src imports a node: module", () => {
    for (const file of readdirSync("sdk/src")) {
      expect(readFileSync(`sdk/src/${file}`, "utf8"), file).not.toMatch(/from "node:|require\(/);
    }
  });
});

/** The files in a .tgz, by path. A tar file is 512-byte headers, each followed by its file padded to 512 bytes. */
function untar(tgz: Buffer): Map<string, string> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, string>();
  const field = (from: number, to: number, header: Buffer) => header.subarray(from, to).toString("utf8").replace(/\0[\s\S]*$/, "");
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = field(0, 100, header);
    if (!name) break;
    const prefix = field(345, 500, header);
    const size = parseInt(field(124, 136, header).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0") files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** What `tsc -p sdk` emits, by path under sdk/, built in memory. */
function buildSdk(): Map<string, string> {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve("sdk/tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error("sdk/tsconfig.json could not be read");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const out = new Map<string, string>();
  const emitted = program.emit(undefined, (fileName, text) => out.set(path.relative(path.resolve("sdk"), fileName).replaceAll("\\", "/"), text));
  const problems = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (problems.length > 0) throw new Error(ts.formatDiagnostics(problems, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  return out;
}

const lf = (text: string | undefined) => text?.replace(/\r\n/g, "\n");

describe("the tarball the site serves", () => {
  it("holds, for this version, exactly what sdk/ builds, its package.json, README and licence: run npm run sdk:pack", () => {
    const files = untar(readFileSync(`public/sdk/vestiarion-sdk-${pkg.version}.tgz`));
    const expected = new Map([...buildSdk()].map(([file, text]) => [`package/${file}`, text]));
    expected.set("package/README.md", readFileSync("sdk/README.md", "utf8"));
    expected.set("package/LICENSE", readFileSync("sdk/LICENSE", "utf8"));
    expect([...files.keys()].sort()).toEqual([...expected.keys(), "package/package.json"].sort());
    for (const [file, text] of expected) expect(lf(files.get(file)), file).toBe(lf(text));
    expect(JSON.parse(files.get("package/package.json") as string)).toEqual(pkg);
  });

  it("exports the root and ./webhooks, both built", () => {
    const built = buildSdk();
    for (const file of ["dist/index.js", "dist/index.d.ts", "dist/webhooks.js", "dist/webhooks.d.ts"]) expect(built.has(file), file).toBe(true);
  });

  it("is served as a download, not sniffed by the browser", async () => {
    expect(await nextConfig.headers!()).toContainEqual({
      source: "/sdk/:path*",
      headers: [
        { key: "Content-Disposition", value: "attachment" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    });
  });
});
