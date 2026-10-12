import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseReleaseTag, splitReleaseNotes } from "../scripts/release-check.mjs";

/**
 * The product's release tags (docs/RELEASING.md): what .github/workflows/release.yml accepts before it creates a
 * GitHub Release, and what it refuses.
 */

const SCRIPT = path.join(process.cwd(), "scripts", "release-check.mjs");

const ACCEPTED: Array<[string, { version: string; channel: string; prerelease: boolean }]> = [
  ["v0.1.0-beta.1", { version: "0.1.0-beta.1", channel: "beta", prerelease: true }],
  ["v0.1.0-alpha.1", { version: "0.1.0-alpha.1", channel: "alpha", prerelease: true }],
  ["v0.1.0-rc.2", { version: "0.1.0-rc.2", channel: "rc", prerelease: true }],
  ["v0.1.0-beta.12", { version: "0.1.0-beta.12", channel: "beta", prerelease: true }],
  ["v0.1.0", { version: "0.1.0", channel: "stable", prerelease: false }],
  ["v0.0.1", { version: "0.0.1", channel: "stable", prerelease: false }],
  ["v1.0.0", { version: "1.0.0", channel: "stable", prerelease: false }],
  ["v1.10.0", { version: "1.10.0", channel: "stable", prerelease: false }],
  ["v2.3.40", { version: "2.3.40", channel: "stable", prerelease: false }],
  ["v10.20.30-rc.1", { version: "10.20.30-rc.1", channel: "rc", prerelease: true }],
];

const REFUSED: Array<[string, string]> = [
  ["", "empty"],
  ["0.1.0", "no v"],
  ["V0.1.0", "capital V"],
  ["v0.1", "two numbers"],
  ["v1", "one number"],
  ["v0.1.0.1", "four numbers"],
  ["v01.0.0", "leading zero in major"],
  ["v0.01.0", "leading zero in minor"],
  ["v0.1.00", "leading zero in patch"],
  ["v0.1.0-beta", "prerelease without a number"],
  ["v0.1.0-beta1", "prerelease number without a dot"],
  ["v0.1.0-beta.0", "prerelease numbers start at 1"],
  ["v0.1.0-beta.01", "leading zero in the prerelease number"],
  ["v0.1.0-BETA.1", "capital prerelease word"],
  ["v0.1.0-preview.1", "another prerelease word"],
  ["v0.1.0-dev.1", "another prerelease word"],
  ["v0.1.0-beta.1.1", "a second prerelease number"],
  ["v0.1.0-beta.1+build.5", "build metadata"],
  ["v0.1.0+20261012", "build metadata on a stable version"],
  ["v0.1.0-", "trailing hyphen"],
  [" v0.1.0", "leading space"],
  ["v0.1.0 ", "trailing space"],
  ["v0.1.0\n", "trailing newline"],
  ["v0.1.0-beta.1\nv0.2.0", "two tags"],
  ["sdk-v0.3.2", "the SDK's own line"],
  ["release-0.1.0", "another prefix"],
  ["refs/tags/v0.1.0", "a full ref"],
  ["v-1.0.0", "negative"],
  ["v0.1.0;rm -rf /", "shell"],
  ["v99999999999999999999.0.0", "a number too large to compare"],
];

describe("parseReleaseTag", () => {
  it.each(ACCEPTED)("accepts %s", (tag, expected) => {
    const parsed = parseReleaseTag(tag);
    expect(parsed).toMatchObject({ ok: true, tag, ...expected });
  });

  it.each(REFUSED)("refuses %j (%s)", (tag) => {
    const parsed = parseReleaseTag(tag);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it("reads the numbers and the prerelease channel", () => {
    expect(parseReleaseTag("v1.2.3-rc.4")).toEqual({
      ok: true,
      tag: "v1.2.3-rc.4",
      version: "1.2.3-rc.4",
      major: 1,
      minor: 2,
      patch: 3,
      channel: "rc",
      number: 4,
      prerelease: true,
    });
    expect(parseReleaseTag("v1.2.3")).toMatchObject({ channel: "stable", number: null, prerelease: false });
  });

  it("refuses a value that is not a string", () => {
    expect(parseReleaseTag(undefined as unknown as string).ok).toBe(false);
  });
});

describe("splitReleaseNotes", () => {
  it("takes the title from the first line and keeps the rest as the body", () => {
    const notes = splitReleaseNotes("# Vestiarion v0.1.0-beta.1 — Public beta\n\nThe first beta.\n\n## Highlights\n", "v0.1.0-beta.1");
    expect(notes).toEqual({ ok: true, title: "Vestiarion v0.1.0-beta.1 — Public beta", body: "The first beta.\n\n## Highlights\n" });
  });

  it("reads Windows line endings and a byte order mark", () => {
    const notes = splitReleaseNotes("﻿# Vestiarion v0.1.0\r\n\r\nBody.\r\n", "v0.1.0");
    expect(notes).toEqual({ ok: true, title: "Vestiarion v0.1.0", body: "Body.\n" });
  });

  it("leaves the title to the workflow when the file has no heading first", () => {
    expect(splitReleaseNotes("Body only.\n", "v0.1.0")).toEqual({ ok: true, title: null, body: "Body only.\n" });
  });

  it("refuses a title that names another version, so last release's notes cannot publish this one", () => {
    const notes = splitReleaseNotes("# Vestiarion v0.1.0-beta.1\n\nBody.\n", "v0.1.0-beta.2");
    expect(notes.ok).toBe(false);
  });

  it("refuses an empty file and a title with nothing under it", () => {
    expect(splitReleaseNotes("", "v0.1.0").ok).toBe(false);
    expect(splitReleaseNotes("# Vestiarion v0.1.0\n\n", "v0.1.0").ok).toBe(false);
  });
});

describe("the committed release notes", () => {
  it("each file in docs/releases is named for a release tag and titled with it", () => {
    const dir = path.join(process.cwd(), "docs", "releases");
    const files = readdirSync(dir).map((name) => path.join(dir, name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(path.extname(file), file).toBe(".md");
      const tag = path.basename(file, ".md");
      expect(parseReleaseTag(tag), file).toMatchObject({ ok: true });
      const notes = splitReleaseNotes(readFileSync(file, "utf8"), tag);
      expect(notes, file).toMatchObject({ ok: true });
      if (notes.ok) expect(notes.title, file).toContain(tag);
    }
  });
});

describe("release-check.mjs on the command line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-check-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(...args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { status: failed.status, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

  it("prints the facts the workflow writes to its outputs", () => {
    expect(run("tag", "v0.1.0-beta.1")).toEqual({
      status: 0,
      stdout: "version=0.1.0-beta.1\nprerelease=true\nchannel=beta\n",
      stderr: "",
    });
    expect(run("tag", "v1.0.0").stdout).toBe("version=1.0.0\nprerelease=false\nchannel=stable\n");
  });

  it("exits 1 with the reason for a tag it refuses", () => {
    const result = run("tag", "v0.1.0-preview.1");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("is not a release tag");
  });

  it("writes the body of a notes file and prints its title", () => {
    const notes = path.join(dir, "notes.md");
    const body = path.join(dir, "body.md");
    writeFileSync(notes, "# Vestiarion v0.2.0\n\nWhat changed.\n");
    expect(run("notes", "v0.2.0", notes, body)).toMatchObject({ status: 0, stdout: "title=Vestiarion v0.2.0\n" });
    expect(readFileSync(body, "utf8")).toBe("What changed.\n");
  });

  it("refuses a notes file titled for another version", () => {
    const notes = path.join(dir, "stale.md");
    writeFileSync(notes, "# Vestiarion v0.1.0\n\nWhat changed.\n");
    expect(run("notes", "v0.2.0", notes, path.join(dir, "unused.md")).status).toBe(1);
  });

  it("explains its usage when called without a command", () => {
    expect(run("publish", "v0.1.0").status).toBe(2);
  });
});
