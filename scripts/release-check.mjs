/**
 * The rules a product release tag must follow, in one place, for the release workflow and for a person checking a
 * tag before pushing it (docs/RELEASING.md):
 *
 *   node scripts/release-check.mjs tag v0.1.0-beta.1
 *   node scripts/release-check.mjs notes v0.1.0-beta.1 docs/releases/v0.1.0-beta.1.md <body-out.md>
 *
 * `tag` prints `version=`, `prerelease=` and `channel=` lines (the workflow appends them to $GITHUB_OUTPUT) and exits
 * 1 with the reason when the tag is not one Vestiarion releases. `notes` takes a curated notes file whose first line
 * may be `# <title>`: it prints `title=` and writes the rest, the release body, to the output path.
 *
 * A product tag is SemVer 2.0.0 with a `v`: vX.Y.Z for a stable release, vX.Y.Z-alpha.N, -beta.N or -rc.N for a
 * prerelease. Nothing else: no build metadata, no other prerelease words, no leading zeros, and N starts at 1. The
 * SDK's own line (`sdk-vX.Y.Z`) is not a product tag. tests/release-check.test.ts lists what is accepted and refused.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** vMAJOR.MINOR.PATCH, optionally -alpha.N, -beta.N or -rc.N; numbers without leading zeros, N from 1. */
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/;

/** No real tag or title comes near this; one that does is a mistake. */
const MAX_LENGTH = 100;

/**
 * @param {string} tag
 * @returns {{ ok: true, tag: string, version: string, major: number, minor: number, patch: number,
 *   channel: "stable" | "alpha" | "beta" | "rc", number: number | null, prerelease: boolean }
 *   | { ok: false, reason: string }}
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || tag.length === 0) return { ok: false, reason: "No tag was given." };
  if (tag.length > MAX_LENGTH) return { ok: false, reason: `The tag is longer than ${MAX_LENGTH} characters.` };
  const match = RELEASE_TAG.exec(tag);
  if (!match) {
    return {
      ok: false,
      reason:
        `"${tag}" is not a release tag. Use vX.Y.Z for a stable release, or vX.Y.Z-alpha.N, vX.Y.Z-beta.N or ` +
        "vX.Y.Z-rc.N for a prerelease (numbers without leading zeros, N from 1).",
    };
  }
  const [, major, minor, patch, channel, number] = match;
  const prerelease = channel !== undefined;
  const safe = [major, minor, patch, number ?? "0"].every((part) => Number.isSafeInteger(Number(part)));
  if (!safe) return { ok: false, reason: `"${tag}" has a number too large to compare.` };
  return {
    ok: true,
    tag,
    version: tag.slice(1),
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    channel: prerelease ? /** @type {"alpha" | "beta" | "rc"} */ (channel) : "stable",
    number: prerelease ? Number(number) : null,
    prerelease,
  };
}

/**
 * Splits a curated notes file into the release title (its first line, when that is `# <title>`) and the body.
 * The title must name the tag, so a file copied from the last release cannot publish under the wrong title.
 *
 * @param {string} markdown
 * @param {string} tag
 * @returns {{ ok: true, title: string | null, body: string } | { ok: false, reason: string }}
 */
export function splitReleaseNotes(markdown, tag) {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const firstBreak = text.indexOf("\n");
  const first = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const heading = /^# (.+)$/.exec(first);
  if (!heading) return text.trim() ? { ok: true, title: null, body: text.trim() + "\n" } : { ok: false, reason: "The notes file is empty." };
  const title = heading[1].trim();
  if (!title.includes(tag)) return { ok: false, reason: `The notes' title "${title}" does not name ${tag}.` };
  if (title.length > MAX_LENGTH) return { ok: false, reason: `The notes' title is longer than ${MAX_LENGTH} characters.` };
  const body = (firstBreak === -1 ? "" : text.slice(firstBreak + 1)).trim();
  if (!body) return { ok: false, reason: "The notes file has a title and nothing under it." };
  return { ok: true, title, body: body + "\n" };
}

/** @param {string[]} argv */
function main(argv) {
  const [command, tag, notesPath, bodyOut] = argv;
  const parsed = parseReleaseTag(tag ?? "");
  if (!parsed.ok) {
    console.error(parsed.reason);
    return 1;
  }
  if (command === "tag") {
    console.log(`version=${parsed.version}`);
    console.log(`prerelease=${parsed.prerelease}`);
    console.log(`channel=${parsed.channel}`);
    return 0;
  }
  if (command === "notes" && notesPath && bodyOut) {
    const notes = splitReleaseNotes(readFileSync(notesPath, "utf8"), parsed.tag);
    if (!notes.ok) {
      console.error(notes.reason);
      return 1;
    }
    writeFileSync(bodyOut, notes.body);
    console.log(`title=${notes.title ?? ""}`);
    return 0;
  }
  console.error("Usage: release-check.mjs tag <tag> | release-check.mjs notes <tag> <notes.md> <body-out.md>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
