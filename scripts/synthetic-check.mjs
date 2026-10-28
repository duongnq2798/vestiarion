/**
 * The production check (docs/superpowers/specs/2026-10-28-production-check-design.md): opens production's public pages
 * from outside Vercel and Supabase, as .github/workflows/synthetic-check.yml runs it every 10 minutes, and tells the
 * team on a private Discord channel when a check fails two rounds running, and once when it passes again.
 *
 *   node scripts/synthetic-check.mjs                                   # one round, nothing kept
 *   node scripts/synthetic-check.mjs --state .synthetic-state.json     # one round, the alert state kept in the file
 *   node scripts/synthetic-check.mjs --loop --minutes 345 --every 10 --state .synthetic-state.json
 *
 * SYNTHETIC_ORIGIN names the deployment (production when unset). MONITOR_DISCORD_WEBHOOK_URL, the only secret, is the
 * team channel's webhook: it is never printed, whole or in part, and without it the checks still run and the log says
 * no alert could be sent (PC7). It reads public pages with GET, holds no token and runs no JavaScript, so no visit is
 * counted (PC10). Node's built-ins only: the workflow checks out this file alone and installs nothing (PC12).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The origin every canonical address names (src/lib/public-origin.ts). */
export const PRODUCTION_ORIGIN = "https://www.vestiarion.xyz";
/** Sent with every check, so Vercel's logs can tell the probes apart (PC10). */
export const USER_AGENT = "vestiarion-synthetic-check (+https://github.com/duongnq2798/vestiarion)";
/** How long a check waits for its whole answer, the body included (PC2). */
export const TIMEOUT_MS = 15_000;
/** Failing rounds in a row before the team is told (PC5). */
export const FAILS_TO_ALERT = 2;
/** Where every post goes: what `postAlert` refuses anything else than (PC6). */
export const DISCORD_WEBHOOKS = "https://discord.com/api/webhooks/";
/** Discord refuses a message's content past 2,000 characters. */
export const DISCORD_CONTENT_MAX = 2000;
const DISCORD_DEADLINE_MS = 10_000;
/** A redirect's target, as far as a message shows it. */
const LOCATION_MAX = 120;

/**
 * @typedef {{ path: string, status: number, contains: readonly string[], lacks?: readonly string[], budgetMs: number }} Check
 * @typedef {{ path: string, ok: boolean, reason: string | null, status: number | null, ms: number }} Result
 * @typedef {{ fails: number, since: string, alerted: boolean, upAt: string | null }} CheckState
 * @typedef {{ checks: Record<string, CheckState> }} State
 * @typedef {{ kind: "down" | "recovered", paths: string[], content: string }} Message
 */

/**
 * What a round opens (PC1). Each text is in the source it comes from and holds nothing React escapes, an apostrophe
 * above all (PC3): tests/synthetic-check.test.ts holds both, and that every free tool is here and in the sitemap. The
 * landing and the open numbers read the database on every request, so their budget is longer.
 *
 * @type {readonly Check[]}
 */
export const CHECKS = [
  { path: "/", status: 200, contains: ["Your AI agent for bills and payments"], budgetMs: 8000 },
  {
    path: "/open",
    status: 200,
    contains: ["Vestiarion, in production"],
    // A read that failed still answers 200, with "The <network> numbers could not be read right now."
    lacks: ["numbers could not be read right now"],
    budgetMs: 8000,
  },
  { path: "/docs", status: 200, contains: ["Vestiarion docs"], budgetMs: 4000 },
  { path: "/check-address", status: 200, contains: ["Check an address before you pay it"], budgetMs: 4000 },
  { path: "/payment-terms", status: 200, contains: ["Payment terms calculator"], budgetMs: 4000 },
  { path: "/check-vendor", status: 200, contains: ["Check your vendors against OFAC"], budgetMs: 4000 },
  { path: "/check-bills", status: 200, contains: ["Check your bill list for duplicates and deadlines"], budgetMs: 4000 },
  { path: "/robots.txt", status: 200, contains: ["Sitemap:", "/sitemap.xml"], budgetMs: 4000 },
  {
    path: "/sitemap.xml",
    status: 200,
    contains: ["<urlset", "/check-address</loc>", "/payment-terms</loc>", "/check-vendor</loc>", "/check-bills</loc>"],
    budgetMs: 4000,
  },
];

/** @type {State} */
export const EMPTY_STATE = Object.freeze({ checks: Object.freeze({}) });

/** 4000 as "4 s", 9123 as "9.1 s". */
function seconds(ms) {
  const value = ms / 1000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} s`;
}

/**
 * A check's verdict on one answer (PC2): no answer, another status (a redirect included, since none is followed), a
 * text missing, a text that must not be there, or a time over the budget, in that order; the first is the reason.
 *
 * @param {Check} check
 * @param {{ status?: number, body?: string, ms: number, error?: string, location?: string | null }} answer
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function evaluate(check, { status, body = "", ms, error, location }) {
  if (error !== undefined) return { ok: false, reason: error };
  if (status !== check.status) {
    const redirect = status !== undefined && status >= 300 && status < 400 && location ? ` (redirected to ${location.slice(0, LOCATION_MAX)})` : "";
    return { ok: false, reason: `answered ${status}${redirect}, expected ${check.status}` };
  }
  const missing = check.contains.filter((text) => !body.includes(text));
  if (missing.length > 0) return { ok: false, reason: `missing ${missing.map((text) => JSON.stringify(text)).join(", ")}` };
  const present = (check.lacks ?? []).filter((text) => body.includes(text));
  if (present.length > 0) return { ok: false, reason: `says ${present.map((text) => JSON.stringify(text)).join(", ")}` };
  if (ms > check.budgetMs) return { ok: false, reason: `took ${seconds(ms)}, over its ${seconds(check.budgetMs)} budget` };
  return { ok: true, reason: null };
}

/** Why a request got no answer, in a few words: never the error's own message. */
function noAnswer(error, timeoutMs) {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `no answer within ${seconds(timeoutMs)}`;
  const code = error instanceof Error && error.cause instanceof Error ? /** @type {{ code?: unknown }} */ (error.cause).code : undefined;
  return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? `no answer (${code})` : "no answer";
}

/**
 * Opens one address with a plain GET, no redirect followed, and gives its verdict and how long the whole answer took.
 *
 * @param {Check} check
 * @param {string} origin
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {Promise<Result>}
 */
export async function checkOnce(check, origin, fetchImpl = fetch, timeoutMs = TIMEOUT_MS) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const response = await fetchImpl(`${origin}${check.path}`, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    const ms = elapsed();
    const verdict = evaluate(check, { status: response.status, body, ms, location: response.headers.get("location") });
    return { path: check.path, ...verdict, status: response.status, ms };
  } catch (error) {
    const ms = elapsed();
    return { path: check.path, ...evaluate(check, { error: noAnswer(error, timeoutMs), ms }), status: null, ms };
  }
}

/** "10:20 UTC" on the day of `now`, "2026-10-27 23:55 UTC" on another. */
function clockTime(iso, now) {
  const time = `${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10) === now.toISOString().slice(0, 10) ? time : `${iso.slice(0, 10)} ${time}`;
}

/** 30 as "30 min", 140 as "2 h 20 min". */
function duration(fromIso, toIso) {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

const checksWord = (count) => (count === 1 ? "check" : "checks");

/**
 * The alert rule (PC5), one round at a time: a failing check counts its failures in a row and keeps the time it started
 * failing; at its second, untold, it goes into the round's one "failing" message; a told check that passes goes into the
 * round's one "passing again" message, keeping the time it first passed. A pass with nothing told is forgotten. Whether
 * a message reached Discord is applied after, with `delivered`, so a message not taken is made again next round (PC6).
 *
 * @param {State} state
 * @param {readonly Result[]} results
 * @param {Date} now
 * @param {{ origin: string, runLink: string | null }} context
 * @returns {{ state: State, messages: Message[] }}
 */
export function nextState(state, results, now, { origin, runLink }) {
  const at = now.toISOString();
  /** @type {Record<string, CheckState>} */
  const checks = {};
  /** @type {string[]} */
  const down = [];
  /** @type {string[]} */
  const recovered = [];
  for (const result of results) {
    const before = state.checks[result.path];
    if (!result.ok) {
      // A check told down that passed and failed again, before its recovery was told, is still the same outage.
      const entry = { fails: (before?.fails ?? 0) + 1, since: before?.since ?? at, alerted: before?.alerted ?? false, upAt: null };
      checks[result.path] = entry;
      if (entry.fails >= FAILS_TO_ALERT && !entry.alerted) down.push(result.path);
    } else if (before?.alerted) {
      checks[result.path] = { fails: 0, since: before.since, alerted: true, upAt: before.upAt ?? at };
      recovered.push(result.path);
    }
  }

  const reasons = new Map(results.map((result) => [result.path, result.reason]));
  const footer = runLink ? [`Run: ${runLink}`] : [];
  /** @type {Message[]} */
  const messages = [];
  if (down.length > 0) {
    const lines = down.map((path) => `- ${path}: ${reasons.get(path)}. Failing since ${clockTime(checks[path].since, now)}.`);
    messages.push({
      kind: "down",
      paths: down,
      content: [`Vestiarion production check: ${down.length} of ${results.length} ${checksWord(results.length)} failed twice running on ${origin}`, ...lines, ...footer].join("\n"),
    });
  }
  if (recovered.length > 0) {
    const lines = recovered.map((path) => {
      const { since, upAt } = checks[path];
      const back = upAt ?? at;
      return `- ${path}: passing again at ${clockTime(back, now)}, after ${duration(since, back)} down.`;
    });
    messages.push({
      kind: "recovered",
      paths: recovered,
      content: [`Vestiarion production check: ${recovered.length} ${checksWord(recovered.length)} passing again on ${origin}`, ...lines, ...footer].join("\n"),
    });
  }
  return { state: { checks }, messages };
}

/**
 * The state once Discord took a message (PC6): the checks it said were failing are told; those it said pass again are
 * forgotten.
 *
 * @param {State} state
 * @param {Message} message
 * @returns {State}
 */
export function delivered(state, message) {
  const checks = { ...state.checks };
  for (const path of message.paths) {
    const entry = checks[path];
    if (entry === undefined) continue;
    if (message.kind === "down") checks[path] = { ...entry, alerted: true };
    else delete checks[path];
  }
  return { checks };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isIso = (value) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));

/**
 * Reads a state file this script wrote (PC8); throws on anything else.
 *
 * @param {string} text
 * @returns {State}
 */
export function parseState(text) {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a state object");
  const raw = parsed.checks;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("no checks in the state");
  /** @type {Record<string, CheckState>} */
  const checks = {};
  for (const [path, entry] of Object.entries(raw)) {
    const valid =
      entry !== null &&
      typeof entry === "object" &&
      Number.isSafeInteger(entry.fails) &&
      entry.fails >= 0 &&
      isIso(entry.since) &&
      typeof entry.alerted === "boolean" &&
      (entry.upAt === null || isIso(entry.upAt));
    if (!valid) throw new Error("a check's state is not one this script writes");
    checks[path] = { fails: entry.fails, since: entry.since, alerted: entry.alerted, upAt: entry.upAt };
  }
  return { checks };
}

/** Written whole or not at all: a run cancelled mid-write keeps the last round's file. */
function saveState(file, state) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * @param {string} file
 * @returns {{ state: State, unreadable: boolean }}
 */
function loadState(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // No file yet: the first run, or no cache to restore.
    if (error instanceof Error && /** @type {{ code?: unknown }} */ (error).code === "ENOENT") return { state: EMPTY_STATE, unreadable: false };
    return { state: EMPTY_STATE, unreadable: true };
  }
  try {
    return { state: parseState(text), unreadable: false };
  } catch {
    return { state: EMPTY_STATE, unreadable: true };
  }
}

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"];
const DISCORD_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{60,100})\/?$/;

/**
 * The webhook to call, rebuilt on discord.com from the id and token in the secret, as the product's own
 * `parseDiscordWebhookUrl` (src/lib/discord/webhook-url.ts) takes it; null for anything else (PC6, PC7).
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function discordWebhook(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "" || /[?#]/.test(raw)) return null;
  if (!DISCORD_HOSTS.includes(parsed.hostname)) return null;
  const match = DISCORD_PATH.exec(parsed.pathname);
  return match ? `${DISCORD_WEBHOOKS}${match[1]}/${match[2]}` : null;
}

/**
 * Posts one message to the team's channel (PC6): the content alone, clipped to 2,000 characters, no mention parsed,
 * embeds suppressed (flag 4) so the run link is not unfurled, no redirect followed, a 10-second deadline, and
 * `?wait=true` so Discord answers once the message exists. A failure is reported, never thrown, and never carries the
 * URL or Discord's answer.
 *
 * @param {string} webhook
 * @param {string} content
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function postAlert(webhook, content, fetchImpl = fetch) {
  if (!webhook.startsWith(DISCORD_WEBHOOKS)) return { ok: false, status: 0 };
  const clipped = content.length <= DISCORD_CONTENT_MAX ? content : `${content.slice(0, DISCORD_CONTENT_MAX - 3)}...`;
  try {
    const response = await fetchImpl(`${webhook}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: clipped, allowed_mentions: { parse: [] }, flags: 4 }),
      redirect: "error",
      signal: AbortSignal.timeout(DISCORD_DEADLINE_MS),
    });
    await response.arrayBuffer().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** One log line per check: what it answered and how long it took, to set the budgets from. */
function logLine(result) {
  const status = result.status === null ? "---" : String(result.status);
  return `${result.ok ? "ok  " : "FAIL"}  ${status.padStart(3)}  ${String(result.ms).padStart(5)} ms  ${result.path}${result.reason ? `: ${result.reason}` : ""}`;
}

/**
 * One round (PC1-PC7): every check at once, a line each in the log, the alert rule, and each message due posted. A
 * message that could not be posted counts in `unsent` and is made again next round.
 *
 * @param {{ origin: string, state: State, now?: Date, webhook: string | null, runLink: string | null,
 *   checks?: readonly Check[], fetchImpl?: typeof fetch, log?: (line: string) => void }} round
 * @returns {Promise<{ state: State, results: Result[], unsent: number }>}
 */
export async function runRound({ origin, state, now = new Date(), webhook, runLink, checks = CHECKS, fetchImpl = fetch, log = console.log }) {
  const results = await Promise.all(checks.map((check) => checkOnce(check, origin, fetchImpl)));
  const passed = results.filter((result) => result.ok).length;
  log(`Round at ${now.toISOString()}: ${passed} of ${results.length} ${checksWord(results.length)} passed.`);
  for (const result of results) log(logLine(result));

  const next = nextState(state, results, now, { origin, runLink });
  let after = next.state;
  let unsent = 0;
  for (const message of next.messages) {
    const what = `${message.paths.length} ${checksWord(message.paths.length)} ${message.kind === "down" ? "failing twice running" : "passing again"} (${message.paths.join(", ")})`;
    if (webhook === null) {
      // A workflow command is one line.
      log(`::warning::No alert could be sent: MONITOR_DISCORD_WEBHOOK_URL is missing or not a Discord webhook URL. It would have said: ${message.content.split("\n").join(" | ")}`);
      unsent += 1;
      continue;
    }
    const posted = await postAlert(webhook, message.content, fetchImpl);
    if (posted.ok) {
      after = delivered(after, message);
      log(`Told the team on Discord: ${what}.`);
    } else {
      log(`::warning::Discord did not take the alert (${posted.status === 0 ? "no answer" : `answered ${posted.status}`}): it is sent again next round.`);
      unsent += 1;
    }
  }
  return { state: after, results, unsent };
}

/** The deployment to check: an http or https origin, production when unset. */
function originOf(raw) {
  if (raw === undefined || raw.trim() === "") return PRODUCTION_ORIGIN;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The run's page on GitHub, from the variables Actions sets; null outside Actions. */
function runLinkOf(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run } = env;
  return server && repository && run && /^\d+$/.test(run) ? `${server}/${repository}/actions/runs/${run}` : null;
}

const USAGE = "Usage: synthetic-check.mjs [--state <file>] [--loop --minutes <n> --every <n>]";

/**
 * The command (PC4, PC7-PC9): one round, or with `--loop` a round every `--every` minutes for `--minutes`, the state
 * read from and written to `--state` after each round. Exits 0 when pages fail: 1 only when the check itself could not
 * do its job, a message due that could not be sent or a state file that could not be read; 2 on wrong arguments.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: (line: string) => void,
 *   clock?: () => number, sleep?: (ms: number) => Promise<unknown> }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, { env = process.env, fetchImpl = fetch, log = console.log, clock = Date.now, sleep = wait } = {}) {
  let options;
  try {
    options = parseArgs({
      args: argv,
      options: { loop: { type: "boolean", default: false }, minutes: { type: "string" }, every: { type: "string" }, state: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    log(USAGE);
    return 2;
  }
  const minutes = Number(options.minutes);
  const every = Number(options.every);
  if (options.loop && !(Number.isInteger(minutes) && minutes > 0 && Number.isInteger(every) && every > 0)) {
    log(USAGE);
    return 2;
  }
  const origin = originOf(env.SYNTHETIC_ORIGIN);
  if (origin === null) {
    log("::error::SYNTHETIC_ORIGIN is not an http or https origin.");
    return 2;
  }

  const secret = env.MONITOR_DISCORD_WEBHOOK_URL ?? "";
  const webhook = secret.trim() === "" ? null : discordWebhook(secret);
  if (secret.trim() === "") log("::warning::MONITOR_DISCORD_WEBHOOK_URL is not set: the checks run, and no alert can be sent.");
  else if (webhook === null) log("::warning::MONITOR_DISCORD_WEBHOOK_URL is not a Discord webhook URL: the checks run, and no alert can be sent.");

  let broken = false;
  let state = EMPTY_STATE;
  if (options.state) {
    const loaded = loadState(options.state);
    state = loaded.state;
    if (loaded.unreadable) {
      log("::warning::The state file could not be read: starting from no failures.");
      broken = true;
    }
  }

  log(`Checking ${origin}: ${CHECKS.length} checks${options.loop ? `, every ${every} minutes for ${minutes} minutes` : ""}.`);
  const runLink = runLinkOf(env);
  const start = clock();
  for (let round = 1; ; round += 1) {
    const outcome = await runRound({ origin, state, now: new Date(clock()), webhook, runLink, fetchImpl, log });
    state = outcome.state;
    if (outcome.unsent > 0) broken = true;
    if (options.state) saveState(options.state, state);
    if (!options.loop) break;
    // Rounds keep to the start's own times, so a slow round does not push the rest later.
    const nextAt = start + round * every * 60_000;
    if (nextAt >= start + minutes * 60_000) break;
    await sleep(Math.max(0, nextAt - clock()));
  }
  return broken ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // Only the kind of error: nothing it carries can echo the secret.
      console.log(`::error::The production check stopped: ${error instanceof Error ? error.name : "an unknown error"}.`);
      process.exitCode = 1;
    }
  );
}
