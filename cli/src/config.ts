import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { usageError } from "./errors.js";
import type { Io } from "./io.js";

/**
 * The saved profiles: one API key each, with the base URL it was checked against. The file is the user's own:
 * - Windows: `%APPDATA%\vestiarion\config.json`;
 * - elsewhere: `$XDG_CONFIG_HOME/vestiarion/config.json`, or `~/.config/vestiarion/config.json`.
 * It is written with mode 0600 (its folder 0700) where the OS has modes, and replaced whole, never half written.
 */
export interface Profile {
  apiKey: string;
  /** Present when the key was checked against another API than the default. */
  baseUrl?: string;
  /** The workspace's name when the key was saved, for `whoami` and `logout` to name it. */
  workspace?: string;
  savedAt?: string;
}

export interface ConfigFile {
  profiles: Record<string, Profile>;
}

export const DEFAULT_PROFILE = "default";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function configPath(io: Pick<Io, "env" | "platform" | "homedir">): string {
  // Windows always sets APPDATA; without it, the file goes where it goes elsewhere.
  if (io.platform === "win32" && io.env.APPDATA) return path.join(io.env.APPDATA, "vestiarion", "config.json");
  // The XDG spec: a relative XDG_CONFIG_HOME is invalid and ignored.
  const xdg = io.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(io.homedir, ".config");
  return path.join(base, "vestiarion", "config.json");
}

/** `--profile`, else `VESTIARION_PROFILE`, else `default`. */
export function profileName(flag: string | undefined, io: Pick<Io, "env">): string {
  const name = flag ?? io.env.VESTIARION_PROFILE ?? DEFAULT_PROFILE;
  if (!PROFILE_NAME.test(name)) {
    throw usageError("A profile name is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.");
  }
  return name;
}

export function readConfig(file: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw usageError(`The config file ${file} could not be read (${(error as Error).message}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(`The config file ${file} is not JSON. Fix it, or delete it and log in again.`);
  }
  const profiles = (parsed as { profiles?: unknown } | null)?.profiles;
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) return { profiles: {} };
  const kept: Record<string, Profile> = {};
  for (const [name, profile] of Object.entries(profiles as Record<string, unknown>)) {
    const p = profile as Partial<Profile> | null;
    if (p && typeof p.apiKey === "string") kept[name] = p as Profile;
  }
  return { profiles: kept };
}

/** Writes the whole file to a private temporary file beside it, then moves that over the old one. */
export function writeConfig(file: string, config: ConfigFile): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    // A mode given to writeFileSync applies only to a file it creates, and a umask may narrow it: set it outright.
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
