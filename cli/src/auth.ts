import { DEFAULT_BASE_URL, Vestiarion, type FetchLike } from "@vestiarion/sdk";
import { configPath, profileName, readConfig } from "./config.js";
import { CliError, EXIT, usageError } from "./errors.js";
import type { Io } from "./io.js";
import { VERSION } from "./version.js";

/** Where the key in use came from. */
export type KeySource = "flag" | "env" | "profile";

export interface Credentials {
  apiKey: string;
  source: KeySource;
  /** The profile read, whether or not the key came from it. */
  profile: string;
  baseUrl: string;
}

export interface AuthFlags {
  "api-key"?: string;
  "base-url"?: string;
  profile?: string;
}

const KEY_FORMAT = /^vxk_([a-z2-7]{8})_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What a person may see of a key: its prefix, as Settings lists it. Never the secret. */
export function maskKey(key: string): string {
  const prefix = KEY_FORMAT.exec(key)?.[1];
  return prefix ? `vxk_${prefix}_…` : "a value that is not a Vestiarion key";
}

export function describeSource(credentials: Credentials): string {
  if (credentials.source === "flag") return "--api-key";
  if (credentials.source === "env") return "VESTIARION_API_KEY";
  return `profile "${credentials.profile}"`;
}

/** An https URL, or plain http to this machine: the key must never travel in the clear. The SDK refuses anything else. */
export function checkBaseUrl(value: string, from: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`${from} is not a URL.`);
  }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) {
    throw usageError(`${from} must be an https URL, or http to localhost: the key must not travel in the clear.`);
  }
  if (url.username || url.password || url.search || url.hash) throw usageError(`${from} must be a plain origin, such as ${DEFAULT_BASE_URL}.`);
  return url.toString().replace(/\/+$/, "");
}

/** `--base-url`, else `VESTIARION_BASE_URL`, else the fallback (a profile's own), else the default. */
export function resolveBaseUrl(flags: AuthFlags, io: Pick<Io, "env">, fallback?: string): string {
  if (flags["base-url"] !== undefined) return checkBaseUrl(flags["base-url"], "--base-url");
  if (io.env.VESTIARION_BASE_URL) return checkBaseUrl(io.env.VESTIARION_BASE_URL, "VESTIARION_BASE_URL");
  if (fallback) return checkBaseUrl(fallback, "The profile's base URL");
  return DEFAULT_BASE_URL;
}

/**
 * The key for this run: `--api-key`, else `VESTIARION_API_KEY`, else the profile's saved key. A profile's base URL goes
 * with its key only, so a key from the flag or the environment is never sent to the API a saved profile names.
 */
export function resolveCredentials(flags: AuthFlags, io: Io): Credentials {
  const profile = profileName(flags.profile, io);
  if (flags["api-key"] !== undefined) return { apiKey: flags["api-key"].trim(), source: "flag", profile, baseUrl: resolveBaseUrl(flags, io) };
  if (io.env.VESTIARION_API_KEY) return { apiKey: io.env.VESTIARION_API_KEY.trim(), source: "env", profile, baseUrl: resolveBaseUrl(flags, io) };
  const saved = readConfig(configPath(io)).profiles[profile];
  if (saved) return { apiKey: saved.apiKey, source: "profile", profile, baseUrl: resolveBaseUrl(flags, io, saved.baseUrl) };
  const named = flags.profile !== undefined || io.env.VESTIARION_PROFILE !== undefined;
  throw new CliError(
    EXIT.AUTH,
    named
      ? `No key is saved for profile "${profile}". Run \`vestiarion login --profile ${profile}\`, or pass --api-key or set VESTIARION_API_KEY.`
      : "No API key. Run `vestiarion login`, or pass --api-key or set VESTIARION_API_KEY."
  );
}

/** Every request says it came from the CLI, then the SDK: `vestiarion-cli/<version> vestiarion-sdk-js/<version>`. */
function withUserAgent(base: FetchLike): FetchLike {
  return (url, init) => base(url, { ...init, headers: { ...init.headers, "user-agent": `vestiarion-cli/${VERSION} ${init.headers["user-agent"] ?? ""}`.trim() } });
}

/** The SDK's client for these credentials. A key that is not shaped like one is refused before anything is sent. */
export function clientFor(credentials: Pick<Credentials, "apiKey" | "baseUrl"> & Partial<Pick<Credentials, "source" | "profile">>, io: Io): Vestiarion {
  if (!KEY_FORMAT.test(credentials.apiKey)) {
    const from =
      credentials.source === "flag"
        ? "--api-key"
        : credentials.source === "env"
          ? "VESTIARION_API_KEY"
          : credentials.source === "profile"
            ? `The key saved for profile "${credentials.profile}"`
            : "That";
    throw new CliError(EXIT.AUTH, `${from} is not a Vestiarion API key: one is shaped vxk_<prefix>_<secret>.`);
  }
  const base = io.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
  return new Vestiarion({
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    fetch: withUserAgent(base),
    ...(io.maxRetries !== undefined ? { maxRetries: io.maxRetries } : {}),
  });
}
