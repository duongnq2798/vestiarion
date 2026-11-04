import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveRobots, resolveSitemap } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { afterAll, describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { DISCORD_CONTENT_MAX } from "@/lib/discord/api";
import { parseDiscordWebhookUrl } from "@/lib/discord/webhook-url";
import { FREE_TOOLS } from "@/lib/free-tools";
import { PRODUCTION_ORIGIN as APP_ORIGIN } from "@/lib/public-origin";
import { STATUS_REASON_MAX as APP_REASON_MAX } from "@/lib/status/file";
import { PAUSED_AFTER_MINUTES as APP_PAUSED_AFTER_MINUTES } from "@/lib/status/summary";
import {
  CHECKS,
  EMPTY_STATE,
  PRODUCTION_ORIGIN,
  TIMEOUT_MS,
  USER_AGENT,
  HISTORY_DAYS,
  HISTORY_READS,
  PAUSED_AFTER_MINUTES,
  STATUS_BRANCH,
  STATUS_REASON_MAX,
  STATUS_SOURCE,
  STATUS_VERCEL_JSON,
  appendRound,
  checkOnce,
  delivered,
  discordWebhook,
  evaluate,
  main,
  nextState,
  parseState,
  parseStatusRounds,
  postAlert,
  publishStatus,
  readPublished,
  runRound,
  statusFile,
  statusReadme,
  statusRound,
} from "../scripts/synthetic-check.mjs";

/**
 * The production check (docs/superpowers/specs/2026-10-28-production-check-design.md PC1-PC12): what a round opens and
 * what each page must say (PC1, PC3), a check's verdict (PC2), the alert rule round by round (PC5), the Discord post and
 * its retry (PC6), the secret kept out of the log (PC7), the state file (PC8), the exit code (PC9), plain reads (PC10),
 * the workflow that runs it (PC4, PC11, PC12), and the owner's steps the docs give for it (PC3, PC4). Every page is
 * served on loopback and Discord is a stub: nothing here reaches the network.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
const SCRIPT = path.join(process.cwd(), "scripts", "synthetic-check.mjs");
const WORKFLOW = read(".github/workflows/synthetic-check.yml");

type Check = (typeof CHECKS)[number];
type Result = Awaited<ReturnType<typeof checkOnce>>;
type State = ReturnType<typeof parseState>;

const checkAt = (route: string): Check => {
  const found = CHECKS.find((check) => check.path === route);
  if (!found) throw new Error(`no check for ${route}`);
  return found;
};

/** Where each page's text comes from: the source a copy edit would change. */
const SOURCES: Record<string, string> = {
  "/": "src/components/landing/Hero.tsx",
  "/open": "src/app/open/page.tsx",
  "/docs": "src/app/docs/[[...slug]]/page.tsx",
  ...Object.fromEntries(FREE_TOOLS.map((tool) => [tool.path, `src/app${tool.path}/page.tsx`])),
};
const FILES = ["/robots.txt", "/sitemap.xml"];

/** A Discord webhook as the owner pastes it; nothing of it may reach the log (PC7). */
const WEBHOOK_ID = "987650123498765012";
const WEBHOOK_TOKEN = "Zq9Xk7_wP2-Lm4Rv8Ty3_Hb6-Nc1Ud5Gx0Ws2Je4-Ko7Pf9_Qa3Mi6Lz8-Yt1Bn5";
const WEBHOOK = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;
const RUN_LINK = "https://github.com/duongnq2798/vestiarion/actions/runs/1";
const CONTEXT = { origin: PRODUCTION_ORIGIN, runLink: RUN_LINK };

/** Every 8 characters in a row of the id and the token: none may be in a log line. */
function secretPieces(): string[] {
  const pieces: string[] = [];
  for (const secret of [WEBHOOK_ID, WEBHOOK_TOKEN]) {
    for (let start = 0; start + 8 <= secret.length; start += 1) pieces.push(secret.slice(start, start + 8));
  }
  return pieces;
}

function expectNoSecret(log: string) {
  for (const piece of secretPieces()) expect(log, piece).not.toContain(piece);
}

// ---- A production on loopback ---------------------------------------------------------------------------------

interface Page {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Never answer. */
  hang?: boolean;
}

/** What production serves when every check passes: each check's own texts. */
function healthy(): Record<string, Page> {
  return Object.fromEntries(CHECKS.map((check) => [check.path, { body: `<html>${check.contains.join("\n")}</html>` }]));
}

interface Served {
  origin: string;
  requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders }>;
  pages: Record<string, Page>;
}

const servers: Array<ReturnType<typeof createServer>> = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

async function serve(pages: Record<string, Page> = healthy()): Promise<Served> {
  const served: Served = { origin: "", requests: [], pages };
  const server = createServer((request, response) => {
    served.requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    const page = served.pages[request.url ?? ""];
    if (page?.hang) return;
    if (!page) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(page.status ?? 200, { "content-type": "text/html", ...page.headers }).end(page.body ?? "");
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  served.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return served;
}

/** A fetch that answers Discord's webhook itself, as `answer` says, and sends every other request on. */
function withDiscord(answer: () => Response = () => new Response("{}", { status: 200 })) {
  const posts: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://discord.com/")) {
      posts.push({ url, init, body: JSON.parse(String(init?.body ?? "{}")) });
      return answer();
    }
    return fetch(input, init);
  };
  return { fetchImpl, posts };
}

function logger() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line), text: () => lines.join("\n") };
}

const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 28, hour, minute));

// ---- What is checked -------------------------------------------------------------------------------------------

describe("what a round opens (PC1, PC3)", () => {
  it("checks the landing, the open numbers, the docs, every free tool, robots.txt and the sitemap, in that order", () => {
    expect(CHECKS.map((check) => check.path)).toEqual(["/", "/open", "/docs", ...FREE_TOOLS.map((tool) => tool.path), ...FILES]);
  });

  it("checks production, the origin every canonical address names", () => {
    expect(PRODUCTION_ORIGIN).toBe(APP_ORIGIN);
  });

  it("expects each one to answer 200, within a budget under the 15-second wait, longer for the pages that read the database", () => {
    expect(TIMEOUT_MS).toBe(15_000);
    for (const check of CHECKS) {
      expect(check.status, check.path).toBe(200);
      expect(check.budgetMs, check.path).toBeLessThan(TIMEOUT_MS);
    }
    for (const [route, page] of [["/", "src/app/page.tsx"], ["/open", "src/app/open/page.tsx"]]) {
      expect(read(page), page).toContain('export const dynamic = "force-dynamic";');
      expect(checkAt(route).budgetMs).toBe(8000);
    }
    for (const check of CHECKS.filter((one) => !["/", "/open"].includes(one.path))) expect(check.budgetMs, check.path).toBe(4000);
  });

  it("finds each page's text in the source it comes from, so a copy edit made without its check fails CI", () => {
    for (const check of CHECKS.filter((one) => !FILES.includes(one.path))) {
      const source = read(SOURCES[check.path]);
      for (const text of [...check.contains, ...(check.lacks ?? [])]) expect(source, `${check.path}: ${text}`).toContain(text);
      expect(check.contains.length, check.path).toBeGreaterThan(0);
    }
    expect(checkAt("/open").lacks).toEqual(["numbers could not be read right now"]);
  });

  it("looks in pages for no character React escapes in HTML, an apostrophe above all", () => {
    for (const check of CHECKS.filter((one) => !FILES.includes(one.path))) {
      for (const text of [...check.contains, ...(check.lacks ?? [])]) expect(text, check.path).not.toMatch(/['"&<>]/);
    }
  });

  it("passes robots.txt and the sitemap as Next.js serves them from the app's own files", () => {
    const answers: Record<string, string> = { "/robots.txt": resolveRobots(robots()), "/sitemap.xml": resolveSitemap(sitemap()) };
    for (const route of FILES) {
      expect(evaluate(checkAt(route), { status: 200, body: answers[route], ms: 100 }), route).toEqual({ ok: true, reason: null });
    }
  });

  it("fails the sitemap when a free tool is not in it, and robots.txt when it names no sitemap", () => {
    for (const tool of FREE_TOOLS) {
      expect(checkAt("/sitemap.xml").contains).toContain(`${tool.path}</loc>`);
      const without = sitemap().filter((entry) => entry.url !== `${APP_ORIGIN}${tool.path}`);
      expect(evaluate(checkAt("/sitemap.xml"), { status: 200, body: resolveSitemap(without), ms: 100 }).ok, tool.path).toBe(false);
    }
    const noSitemap = resolveRobots({ ...robots(), sitemap: undefined });
    expect(evaluate(checkAt("/robots.txt"), { status: 200, body: noSitemap, ms: 100 }).ok).toBe(false);
  });
});

// ---- A check's verdict -----------------------------------------------------------------------------------------

describe("a check's verdict (PC2)", () => {
  const open = checkAt("/open");
  const good = "<h1>Vestiarion, in production</h1>";

  it("passes the expected status with its text, within its budget", () => {
    expect(evaluate(open, { status: 200, body: good, ms: 7999 })).toEqual({ ok: true, reason: null });
  });

  it("fails no answer, with the reason the request gave", () => {
    expect(evaluate(open, { error: "no answer within 15 s", ms: 15_000 })).toEqual({ ok: false, reason: "no answer within 15 s" });
  });

  it("fails another status, and says where a redirect pointed, since none is followed", () => {
    expect(evaluate(open, { status: 500, body: good, ms: 10 })).toEqual({ ok: false, reason: "answered 500, expected 200" });
    expect(evaluate(open, { status: 307, body: "", ms: 10, location: "/login?next=%2Fopen" })).toEqual({
      ok: false,
      reason: "answered 307 (redirected to /login?next=%2Fopen), expected 200",
    });
  });

  it("fails a page that does not say what it must, or says what it must not", () => {
    expect(evaluate(open, { status: 200, body: "<h1>Something else</h1>", ms: 10 })).toEqual({ ok: false, reason: 'missing "Vestiarion, in production"' });
    expect(evaluate(open, { status: 200, body: `${good}The Arc mainnet numbers could not be read right now.`, ms: 10 })).toEqual({
      ok: false,
      reason: 'says "numbers could not be read right now"',
    });
    expect(evaluate(checkAt("/robots.txt"), { status: 200, body: "User-Agent: *\nAllow: /\n", ms: 10 })).toEqual({
      ok: false,
      reason: 'missing "Sitemap:", "/sitemap.xml"',
    });
  });

  it("fails a page slower than its budget", () => {
    expect(evaluate(open, { status: 200, body: good, ms: 9123 })).toEqual({ ok: false, reason: "took 9.1 s, over its 8 s budget" });
  });

  it("gives the first reason only: no answer, then the status, then the text, then the time", () => {
    expect(evaluate(open, { status: 500, body: "", ms: 20_000 }).reason).toBe("answered 500, expected 200");
    expect(evaluate(open, { status: 200, body: "", ms: 20_000 }).reason).toBe('missing "Vestiarion, in production"');
  });
});

describe("a round against a server (PC2, PC10)", () => {
  it("opens every address with a plain GET named by its user agent, with no cookie or token, and passes a healthy production", async () => {
    const production = await serve();
    const { log, text } = logger();
    const round = await runRound({ origin: production.origin, state: EMPTY_STATE, now: at(10, 0), webhook: null, runLink: null, log });
    expect(round.results.map((result: Result) => [result.path, result.ok])).toEqual(CHECKS.map((check) => [check.path, true]));
    expect(round.unsent).toBe(0);
    expect(round.state).toEqual(EMPTY_STATE);
    expect(production.requests.map((request) => request.url).sort()).toEqual(CHECKS.map((check) => check.path).sort());
    for (const request of production.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers["user-agent"]).toBe(USER_AGENT);
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    }
    expect(USER_AGENT).toBe("vestiarion-synthetic-check (+https://github.com/duongnq2798/vestiarion)");
    // One line per check in the log: its status and time, to set the budgets from.
    for (const check of CHECKS) expect(text()).toMatch(new RegExp(`ok\\s+200\\s+\\d+ ms\\s+${check.path.replace(/[.]/g, "\\.")}(\\n|$)`));
  });

  it("does not follow a redirect", async () => {
    const pages = healthy();
    pages["/docs"] = { status: 308, headers: { location: "/docs/overview" } };
    const production = await serve(pages);
    const round = await runRound({ origin: production.origin, state: EMPTY_STATE, now: at(10, 0), webhook: null, runLink: null, log: () => undefined });
    expect(round.results.find((result: Result) => result.path === "/docs")).toMatchObject({
      ok: false,
      status: 308,
      reason: "answered 308 (redirected to /docs/overview), expected 200",
    });
    expect(production.requests.map((request) => request.url)).not.toContain("/docs/overview");
  });

  it("gives up on a page that does not answer in time", async () => {
    const pages = healthy();
    pages["/check-bills"] = { hang: true };
    const production = await serve(pages);
    const result = await checkOnce(checkAt("/check-bills"), production.origin, fetch, 300);
    expect(result).toMatchObject({ path: "/check-bills", ok: false, status: null, reason: "no answer within 0.3 s" });
  });

  it("says a server that cannot be reached gave no answer, and nothing more of the error", async () => {
    const production = await serve();
    const closed = production.origin.replace(/:\d+$/, ":1");
    const result = await checkOnce(checkAt("/"), closed);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^no answer( \([A-Z_]+\))?$/);
  }, 20_000);
});

// ---- The alert rule --------------------------------------------------------------------------------------------

/** One round's results: the listed paths fail with `reason`, every other check passes. */
function round(failing: string[], reason = "answered 500, expected 200"): Result[] {
  return CHECKS.map((check) =>
    failing.includes(check.path)
      ? { path: check.path, ok: false, reason, status: 500, ms: 120 }
      : { path: check.path, ok: true, reason: null, status: 200, ms: 120 }
  );
}

/** Runs rounds 10 minutes apart from 10:00, each message taken by Discord unless `refused` names its round. */
function rounds(sequence: string[][], refused: number[] = []) {
  let state: State = EMPTY_STATE;
  const told: Array<{ round: number; kind: string; paths: string[]; content: string }> = [];
  sequence.forEach((failing, index) => {
    const next = nextState(state, round(failing), at(10, index * 10), CONTEXT);
    state = next.state;
    for (const message of next.messages) {
      told.push({ round: index, ...message });
      if (!refused.includes(index)) state = delivered(state, message);
    }
  });
  return { state, told };
}

describe("when the team is told (PC5)", () => {
  it("tells nothing of one failure", () => {
    const { state, told } = rounds([["/open"]]);
    expect(told).toEqual([]);
    expect(state.checks["/open"]).toEqual({ fails: 1, since: "2026-10-28T10:00:00.000Z", alerted: false, upAt: null });
  });

  it("tells a second failure in a row once, with the reason, the time it started failing, the origin and the run", () => {
    const { told } = rounds([["/open"], ["/open"]]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ round: 1, kind: "down", paths: ["/open"] });
    expect(told[0].content).toBe(
      [
        `Vestiarion production check: 1 of ${CHECKS.length} checks failed twice running on ${PRODUCTION_ORIGIN}`,
        "- /open: answered 500, expected 200. Failing since 10:00 UTC.",
        `Run: ${RUN_LINK}`,
      ].join("\n")
    );
  });

  it("tells nothing more while it keeps failing", () => {
    const { told } = rounds([["/open"], ["/open"], ["/open"], ["/open"]]);
    expect(told.map((one) => one.round)).toEqual([1]);
  });

  it("tells once that it passes again, with the time and how long it was down, then forgets it", () => {
    const { state, told } = rounds([["/open"], ["/open"], ["/open"], [], []]);
    expect(told.map((one) => [one.round, one.kind])).toEqual([
      [1, "down"],
      [3, "recovered"],
    ]);
    expect(told[1].content).toBe(
      [
        `Vestiarion production check: 1 check passing again on ${PRODUCTION_ORIGIN}`,
        "- /open: passing again at 10:30 UTC, after 30 min down.",
        `Run: ${RUN_LINK}`,
      ].join("\n")
    );
    expect(state).toEqual(EMPTY_STATE);
  });

  it("never tells a failure followed by a pass, and forgets it", () => {
    const { state, told } = rounds([["/open"], [], ["/open"], []]);
    expect(told).toEqual([]);
    expect(state).toEqual(EMPTY_STATE);
  });

  it("tells a whole-site outage in one post listing every check, within Discord's 2,000 characters", () => {
    const everything = CHECKS.map((check) => check.path);
    const { told } = rounds([everything, everything]);
    expect(told).toHaveLength(1);
    expect(told[0].paths).toEqual(everything);
    for (const check of CHECKS) expect(told[0].content).toContain(`\n- ${check.path}: answered 500, expected 200.`);
    expect(told[0].content.length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
  });

  it("tells a second check that reaches its second failure on its own, not the one already told", () => {
    const { told } = rounds([["/open"], ["/open"], ["/open", "/docs"], ["/open", "/docs"]]);
    expect(told.map((one) => [one.round, one.paths])).toEqual([
      [1, ["/open"]],
      [3, ["/docs"]],
    ]);
  });

  it("tells the day too when the failure started on another day", () => {
    const first = nextState(EMPTY_STATE, round(["/"]), new Date(Date.UTC(2026, 9, 27, 23, 55)), CONTEXT);
    const second = nextState(first.state, round(["/"]), new Date(Date.UTC(2026, 9, 28, 0, 5)), CONTEXT);
    expect(second.messages[0].content).toContain("- /: answered 500, expected 200. Failing since 2026-10-27 23:55 UTC.");
    const told = delivered(second.state, second.messages[0]);
    const back = nextState(told, round([]), new Date(Date.UTC(2026, 9, 28, 2, 15)), CONTEXT);
    expect(back.messages[0].content).toContain("- /: passing again at 02:15 UTC, after 2 h 20 min down.");
  });

  it("forgets a check that is no longer in the list", () => {
    const { state } = rounds([["/open"], ["/open"]]);
    const fewer = nextState(state, round([]).filter((result) => result.path !== "/open"), at(10, 20), CONTEXT);
    expect(fewer).toEqual({ state: EMPTY_STATE, messages: [] });
  });
});

describe("a post Discord did not take (PC6)", () => {
  it("leaves the check untold, so the next round tells it", () => {
    const { told, state } = rounds([["/open"], ["/open"], ["/open"]], [1]);
    expect(told.map((one) => [one.round, one.kind, one.paths])).toEqual([
      [1, "down", ["/open"]],
      [2, "down", ["/open"]],
    ]);
    expect(state.checks["/open"].alerted).toBe(true);
  });

  it("tells a check passing again in the next round, with the time it first passed", () => {
    const { told, state } = rounds([["/open"], ["/open"], [], []], [2]);
    expect(told.map((one) => [one.round, one.kind])).toEqual([
      [1, "down"],
      [2, "recovered"],
      [3, "recovered"],
    ]);
    expect(told[2].content).toContain("- /open: passing again at 10:20 UTC, after 20 min down.");
    expect(state).toEqual(EMPTY_STATE);
  });

  it("does not tell again a check that fails before its recovery was told", () => {
    const { told, state } = rounds([["/open"], ["/open"], [], ["/open"], ["/open"]], [2]);
    expect(told.map((one) => [one.round, one.kind])).toEqual([
      [1, "down"],
      [2, "recovered"],
    ]);
    expect(state.checks["/open"]).toMatchObject({ alerted: true, since: "2026-10-28T10:00:00.000Z", upAt: null });
  });
});

describe("the state file (PC8)", () => {
  it("reads back what it wrote", () => {
    const { state } = rounds([["/open", "/docs"], ["/open"]]);
    expect(parseState(JSON.stringify(state))).toEqual(state);
    expect(parseState(JSON.stringify(EMPTY_STATE))).toEqual(EMPTY_STATE);
  });

  it("refuses a file it did not write", () => {
    for (const text of ["", "{", "[]", "null", '{"checks":[]}', '{"checks":{"/":{"fails":"1","since":"2026-10-28T10:00:00.000Z","alerted":false,"upAt":null}}}', '{"checks":{"/":{"fails":1,"since":"yesterday","alerted":false,"upAt":null}}}']) {
      expect(() => parseState(text), text).toThrow();
    }
  });
});

// ---- Telling Discord -------------------------------------------------------------------------------------------

describe("the Discord post (PC6, PC7)", () => {
  it("takes the webhook URLs the product's own parser takes, and calls only the form rebuilt on discord.com", () => {
    const inputs = [
      WEBHOOK,
      ` ${WEBHOOK}/ `,
      `https://discordapp.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `https://ptb.discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `https://canary.discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `http://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `https://discord.com.evil.example/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `https://user@discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `https://discord.com:8443/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
      `${WEBHOOK}?wait=true`,
      `${WEBHOOK}#x`,
      `https://discord.com/api/webhooks/${WEBHOOK_ID}/short`,
      `https://discord.com/api/webhooks/123/${WEBHOOK_TOKEN}`,
      `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}/slack`,
      "not a url",
      "",
    ];
    for (const input of inputs) expect(discordWebhook(input), input).toBe(parseDiscordWebhookUrl(input)?.url ?? null);
    expect(discordWebhook(`https://discordapp.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`)).toBe(WEBHOOK);
  });

  it("posts the content alone, with no mention parsed, embeds suppressed and no redirect followed, and waits for Discord", async () => {
    const discord = withDiscord();
    expect(await postAlert(WEBHOOK, "Vestiarion production check: test", discord.fetchImpl)).toEqual({ ok: true, status: 200 });
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0].url).toBe(`${WEBHOOK}?wait=true`);
    expect(discord.posts[0].init).toMatchObject({ method: "POST", redirect: "error", headers: { "content-type": "application/json" } });
    expect(discord.posts[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(discord.posts[0].body).toEqual({ content: "Vestiarion production check: test", allowed_mentions: { parse: [] }, flags: 4 });
  });

  it("clips the content to Discord's 2,000 characters", async () => {
    const discord = withDiscord();
    await postAlert(WEBHOOK, "x".repeat(3000), discord.fetchImpl);
    const content = String(discord.posts[0].body.content);
    expect(content).toHaveLength(DISCORD_CONTENT_MAX);
    expect(content.endsWith("...")).toBe(true);
  });

  it("calls nothing but Discord's webhooks, and reports a refusal or no answer instead of throwing", async () => {
    const discord = withDiscord(() => new Response("{}", { status: 404 }));
    expect(await postAlert("https://example.com/api/webhooks/1/2", "x", discord.fetchImpl)).toEqual({ ok: false, status: 0 });
    expect(discord.posts).toHaveLength(0);
    expect(await postAlert(WEBHOOK, "x", discord.fetchImpl)).toEqual({ ok: false, status: 404 });
    const unreachable: typeof fetch = async () => {
      throw new TypeError(`fetch failed for ${WEBHOOK}`);
    };
    expect(await postAlert(WEBHOOK, "x", unreachable)).toEqual({ ok: false, status: 0 });
  });

  it("tells the team from a round, keeps the webhook out of the log, and marks the check told", async () => {
    const pages = healthy();
    pages["/open"] = { status: 500, body: "Internal Server Error" };
    const production = await serve(pages);
    const discord = withDiscord();
    const { log, text } = logger();
    const first = await runRound({ origin: production.origin, state: EMPTY_STATE, now: at(10, 0), webhook: WEBHOOK, runLink: RUN_LINK, fetchImpl: discord.fetchImpl, log });
    expect(discord.posts).toHaveLength(0);
    const second = await runRound({ origin: production.origin, state: first.state, now: at(10, 10), webhook: WEBHOOK, runLink: RUN_LINK, fetchImpl: discord.fetchImpl, log });
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0].body.content).toContain(`failed twice running on ${production.origin}\n- /open: answered 500, expected 200. Failing since 10:00 UTC.`);
    expect(second).toMatchObject({ unsent: 0, state: { checks: { "/open": { fails: 2, alerted: true } } } });
    expect(text()).toContain("Told the team on Discord: 1 check failing twice running (/open).");
    expectNoSecret(text());
  });

  it("says in the log that Discord refused, without the webhook, and tells it again the next round", async () => {
    const pages = healthy();
    pages["/check-vendor"] = { status: 502 };
    const production = await serve(pages);
    const discord = withDiscord(() => new Response(`{"message":"Unknown Webhook","code":10015,"url":"${WEBHOOK}"}`, { status: 404 }));
    const { log, text } = logger();
    let state: State = EMPTY_STATE;
    for (const minute of [0, 10, 20]) {
      const outcome = await runRound({ origin: production.origin, state, now: at(10, minute), webhook: WEBHOOK, runLink: RUN_LINK, fetchImpl: discord.fetchImpl, log });
      state = outcome.state;
      expect(outcome.unsent).toBe(minute === 0 ? 0 : 1);
    }
    expect(discord.posts).toHaveLength(2);
    expect(state.checks["/check-vendor"]).toMatchObject({ fails: 3, alerted: false });
    expect(text()).toContain("::warning::Discord did not take the alert (answered 404): it is sent again next round.");
    expectNoSecret(text());
  });

  it("with no webhook, still checks and says in the log what could not be sent", async () => {
    const pages = healthy();
    pages["/"] = { status: 503 };
    const production = await serve(pages);
    const { log, text } = logger();
    const first = await runRound({ origin: production.origin, state: EMPTY_STATE, now: at(10, 0), webhook: null, runLink: null, log });
    const second = await runRound({ origin: production.origin, state: first.state, now: at(10, 10), webhook: null, runLink: null, log });
    expect(second.unsent).toBe(1);
    expect(second.state.checks["/"]).toMatchObject({ fails: 2, alerted: false });
    // A workflow command is one line, so the post's lines are joined.
    expect(text()).toContain(
      "::warning::No alert could be sent: MONITOR_DISCORD_WEBHOOK_URL is missing or not a Discord webhook URL. It would have said: " +
        `Vestiarion production check: 1 of ${CHECKS.length} checks failed twice running on ${production.origin} | - /: answered 503, expected 200. Failing since 10:00 UTC.`
    );
  });
});

// ---- The command -----------------------------------------------------------------------------------------------

describe("the command (PC7, PC8, PC9)", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "synthetic-check-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  /** A clock that moves only when the loop sleeps. */
  function fakeTime(start = at(10, 0).getTime()) {
    let now = start;
    const slept: number[] = [];
    return {
      clock: () => now,
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
      slept,
    };
  }

  it("loops a round every 10 minutes for the minutes given, and writes the state after each round", async () => {
    const pages = healthy();
    pages["/open"] = { status: 500 };
    const production = await serve(pages);
    const discord = withDiscord();
    const time = fakeTime();
    const statePath = path.join(folder, "loop.json");
    const { log, text } = logger();
    const env = { SYNTHETIC_ORIGIN: production.origin, MONITOR_DISCORD_WEBHOOK_URL: WEBHOOK, GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "duongnq2798/vestiarion", GITHUB_RUN_ID: "42" };
    const code = await main(["--loop", "--minutes", "30", "--every", "10", "--state", statePath], { env, fetchImpl: discord.fetchImpl, log, clock: time.clock, sleep: time.sleep });
    expect(code).toBe(0);
    expect(time.slept).toEqual([600_000, 600_000]);
    expect(production.requests.filter((request) => request.url === "/open")).toHaveLength(3);
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0].body.content).toContain("Run: https://github.com/duongnq2798/vestiarion/actions/runs/42");
    expect(parseState(readFileSync(statePath, "utf8")).checks["/open"]).toEqual({ fails: 3, since: "2026-10-28T10:00:00.000Z", alerted: true, upAt: null });
    expectNoSecret(text());
  });

  it("goes on from the state an earlier run left", async () => {
    const pages = healthy();
    pages["/open"] = { status: 500 };
    const production = await serve(pages);
    const statePath = path.join(folder, "earlier.json");
    writeFileSync(statePath, JSON.stringify(nextState(EMPTY_STATE, round(["/open"]), at(9, 50), CONTEXT).state));
    const discord = withDiscord();
    const code = await main(["--state", statePath], { env: { SYNTHETIC_ORIGIN: production.origin, MONITOR_DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl: discord.fetchImpl, log: () => undefined, clock: () => at(10, 0).getTime() });
    expect(code).toBe(0);
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0].body.content).toContain("Failing since 09:50 UTC.");
  });

  it("fails the run only when an alert that was due could not be sent", async () => {
    const pages = healthy();
    pages["/payment-terms"] = { status: 500 };
    const production = await serve(pages);
    const { log, text } = logger();
    const time = fakeTime();
    const code = await main(["--loop", "--minutes", "20", "--every", "10"], { env: { SYNTHETIC_ORIGIN: production.origin }, log, clock: time.clock, sleep: time.sleep });
    expect(code).toBe(1);
    expect(text()).toContain("::warning::MONITOR_DISCORD_WEBHOOK_URL is not set: the checks run, and no alert can be sent.");
    expect(text()).toContain("::warning::No alert could be sent");

    const healthyProduction = await serve();
    expect(await main([], { env: { SYNTHETIC_ORIGIN: healthyProduction.origin }, log: () => undefined })).toBe(0);
  });

  it("starts from no failures when the state file cannot be read, says so, fails the run and writes a good file", async () => {
    const production = await serve();
    const statePath = path.join(folder, "broken.json");
    writeFileSync(statePath, "{not json");
    const { log, text } = logger();
    const code = await main(["--state", statePath], { env: { SYNTHETIC_ORIGIN: production.origin, MONITOR_DISCORD_WEBHOOK_URL: WEBHOOK }, log });
    expect(code).toBe(1);
    expect(text()).toContain("::warning::The state file could not be read: starting from no failures.");
    expect(parseState(readFileSync(statePath, "utf8"))).toEqual(EMPTY_STATE);
  });

  it("starts from no failures, quietly, when there is no state file yet", async () => {
    const production = await serve();
    const statePath = path.join(folder, "first.json");
    const { log, text } = logger();
    expect(await main(["--state", statePath], { env: { SYNTHETIC_ORIGIN: production.origin, MONITOR_DISCORD_WEBHOOK_URL: WEBHOOK }, log })).toBe(0);
    expect(text()).not.toContain("::warning::");
    expect(parseState(readFileSync(statePath, "utf8"))).toEqual(EMPTY_STATE);
  });

  it("refuses arguments it does not know, and an origin that is not http or https", async () => {
    expect(await main(["--loop"], { env: {}, log: () => undefined })).toBe(2);
    expect(await main(["--every", "10", "--surprise"], { env: {}, log: () => undefined })).toBe(2);
    expect(await main([], { env: { SYNTHETIC_ORIGIN: "ftp://www.vestiarion.xyz" }, log: () => undefined })).toBe(2);
  });

  it("runs as GitHub runs it, never printing a webhook URL it cannot use, whole or in part", async () => {
    const production = await serve();
    const notDiscord = `https://example.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT, "--state", path.join(folder, "cli.json")], {
      env: { ...process.env, SYNTHETIC_ORIGIN: production.origin, MONITOR_DISCORD_WEBHOOK_URL: notDiscord },
      timeout: 30_000,
    });
    expect(stdout).toContain("::warning::MONITOR_DISCORD_WEBHOOK_URL is not a Discord webhook URL: the checks run, and no alert can be sent.");
    expect(stdout).toContain(`Checking ${production.origin}: ${CHECKS.length} checks.`);
    expectNoSecret(stdout + stderr);
  }, 40_000);
});

// ---- The status branch (status page SP1-SP5) -------------------------------------------------------------------

/** The job's own token, as GitHub gives it to the step: nothing of it may reach the log. */
const GITHUB_TOKEN = "ghs_Kz8Qw3Lm5Np7Rt9Vx2Yb4Dc6Fg8Hj0Ks2Lm4Np";

function expectNoToken(log: string) {
  for (let start = 0; start + 8 <= GITHUB_TOKEN.length; start += 1) expect(log).not.toContain(GITHUB_TOKEN.slice(start, start + 8));
}

const pass = (route: string, ms = 100): Result => ({ path: route, ok: true, reason: null, status: 200, ms });
const fail = (route: string, reason = "answered 500, expected 200", ms = 200): Result => ({ path: route, ok: false, reason, status: 500, ms });

interface GithubCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/**
 * A fetch that plays GitHub's REST API for the status branch, and sends every other request on. `published` is what
 * the branch's status.json holds (null: no branch yet), `answer` can refuse a call, and a ref that does not exist yet is
 * answered 422, as GitHub answers it.
 */
function withGithub({ published = null as string | null, answer = ((() => null) as (call: GithubCall) => Response | null) } = {}) {
  const calls: GithubCall[] = [];
  let branch: string | null = published === null ? null : "f".repeat(40);
  let file = published;
  const trees = new Map<string, Array<{ path: string; content: string }>>();
  const commits = new Map<string, string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.github.com/")) return fetch(input, init);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const call: GithubCall = { method: init?.method ?? "GET", path: url.slice("https://api.github.com".length), headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const refused = answer(call);
    if (refused) return refused;
    const repo = "/repos/duongnq2798/vestiarion";
    if (call.method === "GET" && call.path === `${repo}/contents/status.json?ref=refs/heads/status`) {
      return file === null ? new Response("{}", { status: 404 }) : new Response(file, { status: 200 });
    }
    if (call.method === "GET" && call.path === `${repo}/git/ref/heads/status`) {
      return branch === null ? new Response("{}", { status: 404 }) : Response.json({ ref: "refs/heads/status", object: { sha: branch } }, { status: 200 });
    }
    if (call.method === "POST" && call.path === `${repo}/git/trees`) {
      const sha = String(trees.size + 1).padStart(40, "a");
      trees.set(sha, (call.body?.tree as Array<{ path: string; content: string }>).map(({ path: name, content }) => ({ path: name, content })));
      return Response.json({ sha }, { status: 201 });
    }
    if (call.method === "POST" && call.path === `${repo}/git/commits`) {
      const sha = String(commits.size + 1).padStart(40, "c");
      commits.set(sha, String(call.body?.tree));
      return Response.json({ sha }, { status: 201 });
    }
    const point = (sha: string) => {
      branch = sha;
      file = trees.get(commits.get(sha) ?? "")?.find((entry) => entry.path === "status.json")?.content ?? null;
    };
    if (call.method === "PATCH" && call.path === `${repo}/git/refs/heads/status`) {
      if (branch === null) return Response.json({ message: "Reference does not exist" }, { status: 422 });
      point(String(call.body?.sha));
      return Response.json({ ref: "refs/heads/status" }, { status: 200 });
    }
    if (call.method === "POST" && call.path === `${repo}/git/refs`) {
      point(String(call.body?.sha));
      return Response.json({ ref: "refs/heads/status" }, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls, trees, published: () => file };
}

const DAY_MS = 24 * 60 * 60_000;

/** The commit actions/cache's v4 tag named when the workflow was pinned to it. */
const CACHE_COMMIT = "0057852bfaa89a56745cba8c7296529d2fc39830";

describe("the status branch (status page SP1-SP5)", () => {
  it("keeps a round as [1, ms] for a pass and [0, ms, reason] for a failure, the reason clipped as the page reads it", () => {
    expect(STATUS_REASON_MAX).toBe(120);
    expect(APP_REASON_MAX).toBe(STATUS_REASON_MAX);
    const long = "x".repeat(STATUS_REASON_MAX + 50);
    expect(statusRound([pass("/", 4697), fail("/open", "answered 500, expected 200", 812), fail("/docs", long)], at(10, 0))).toEqual({
      at: "2026-10-28T10:00:00.000Z",
      results: { "/": [1, 4697], "/open": [0, 812, "answered 500, expected 200"], "/docs": [0, 200, "x".repeat(STATUS_REASON_MAX)] },
    });
  });

  it("appends each round and keeps only the last 7 days, oldest first", () => {
    const now = at(10, 0);
    const old = { at: new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString(), results: { "/": [1, 1] as [1, number] } };
    const kept = { at: new Date(now.getTime() - HISTORY_DAYS * DAY_MS + 60_000).toISOString(), results: { "/": [1, 2] as [1, number] } };
    const later = { at: new Date(now.getTime() + 60_000).toISOString(), results: { "/": [1, 3] as [1, number] } };
    const round = statusRound([pass("/")], now);
    expect(appendRound([kept, old, later], round, now)).toEqual([kept, round]);
  });

  it("writes the file the status page reads, and a README with the last round, for GitHub to show", () => {
    const rounds = [statusRound([pass("/"), pass("/open")], at(9, 50)), statusRound([pass("/"), fail("/open", "missing \"a | b\" <b>")], at(10, 0))];
    const file = statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS.slice(0, 2), rounds });
    expect(file).toEqual({
      version: 1,
      source: STATUS_SOURCE,
      origin: PRODUCTION_ORIGIN,
      everyMinutes: 10,
      updatedAt: "2026-10-28T10:00:00.000Z",
      checks: [{ path: "/", budgetMs: 8000 }, { path: "/open", budgetMs: 8000 }],
      rounds,
    });
    const readme = statusReadme(file);
    expect(readme).toContain("# Vestiarion status");
    expect(readme).toContain("by a monitor on GitHub's servers, outside Vestiarion's own hosting, about every 10 minutes. The full page: https://www.vestiarion.xyz/status");
    expect(readme).toContain("Last checked: 2026-10-28 10:00 UTC. 1 of 2 pages up.");
    expect(readme).toContain(`If that time is more than ${PAUSED_AFTER_MINUTES} minutes old, monitoring paused`);
    expect(readme).toContain("| [/](https://www.vestiarion.xyz/) | Up | 100 ms | up 2 of 2 times checked |");
    // A reason never breaks the table or becomes a tag.
    expect(readme).toContain("| [/open](https://www.vestiarion.xyz/open) | Failed: missing \"a &#124; b\" &#60;b&#62; | 200 ms | up 1 of 2 times checked |");
    expect(readme).toContain("Something wrong? Tell us on GitHub Issues: https://github.com/duongnq2798/vestiarion/issues");
    expect(statusReadme(file, "someone/fork")).toContain("https://github.com/someone/fork/issues");
    const one = statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS.slice(0, 1), rounds: rounds.slice(0, 1) });
    expect(statusReadme(one)).toContain("| [/](https://www.vestiarion.xyz/) | Up | 100 ms | up 1 of 1 time checked |");
    expect(statusReadme(statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS, rounds: [] }))).toContain("No results yet.");
    // The page and the README call a check paused after the same time.
    expect(PAUSED_AFTER_MINUTES).toBe(APP_PAUSED_AFTER_MINUTES);
    expect(JSON.parse(STATUS_VERCEL_JSON)).toEqual({ git: { deploymentEnabled: false } });
  });

  it("reads back only a file it wrote", () => {
    const rounds = [statusRound([pass("/"), fail("/open")], at(10, 0))];
    const text = JSON.stringify(statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS, rounds }));
    expect(parseStatusRounds(text)).toEqual(rounds);
    for (const bad of [
      "{not json",
      JSON.stringify({ version: 2, rounds: [] }),
      JSON.stringify({ version: 1, rounds: [{ at: "yesterday", results: {} }] }),
      JSON.stringify({ version: 1, rounds: [{ at: "2026-10-28T10:00:00.000Z", results: { "/": [1] } }] }),
      JSON.stringify({ version: 1, rounds: [{ at: "2026-10-28T10:00:00.000Z", results: { "/": [0, 5] } }] }),
      JSON.stringify({ version: 1, rounds: [{ at: "2026-10-28T10:00:00.000Z", results: { open: [1, 5] } }] }),
    ]) {
      expect(() => parseStatusRounds(bad), bad).toThrow();
    }
  });

  it("publishes a tree of the three files, a commit with no parent, and moves the status branch to it by force", async () => {
    const github = withGithub({ published: "{}" });
    const file = statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS, rounds: [statusRound([pass("/")], at(10, 0))] });
    expect(await publishStatus({ token: GITHUB_TOKEN, repository: "duongnq2798/vestiarion", file, fetchImpl: github.fetchImpl })).toEqual({ ok: true, step: "ref", status: 200 });
    expect(github.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /repos/duongnq2798/vestiarion/git/trees",
      "POST /repos/duongnq2798/vestiarion/git/commits",
      "PATCH /repos/duongnq2798/vestiarion/git/refs/heads/status",
    ]);
    for (const call of github.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(call.headers["user-agent"]).toBe(USER_AGENT);
    }
    const tree = github.calls[0].body?.tree as Array<{ path: string; mode: string; type: string; content: string }>;
    expect(tree.map((entry) => [entry.path, entry.mode, entry.type])).toEqual([
      ["status.json", "100644", "blob"],
      ["README.md", "100644", "blob"],
      ["vercel.json", "100644", "blob"],
    ]);
    expect(JSON.parse(tree[0].content)).toEqual(file);
    expect(tree[2].content).toBe(STATUS_VERCEL_JSON);
    expect(github.calls[1].body).toEqual({ message: "Production status at 2026-10-28T10:00:00.000Z", tree: "a".repeat(39) + "1", parents: [] });
    expect(github.calls[2].body).toEqual({ sha: "c".repeat(39) + "1", force: true });
  });

  it("makes the branch on the first round ever, when GitHub says it does not exist", async () => {
    const github = withGithub();
    const file = statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS, rounds: [statusRound([pass("/")], at(10, 0))] });
    expect(await publishStatus({ token: GITHUB_TOKEN, repository: "duongnq2798/vestiarion", file, fetchImpl: github.fetchImpl })).toEqual({ ok: true, step: "ref", status: 201 });
    expect(github.calls.slice(2).map((call) => [call.method, call.path, call.body])).toEqual([
      ["PATCH", "/repos/duongnq2798/vestiarion/git/refs/heads/status", { sha: "c".repeat(39) + "1", force: true }],
      ["POST", "/repos/duongnq2798/vestiarion/git/refs", { ref: "refs/heads/status", sha: "c".repeat(39) + "1" }],
    ]);
  });

  it("reports a refusal by its step and status, and never throws", async () => {
    const file = statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS, rounds: [] });
    const refuseTrees = withGithub({ answer: (call) => (call.path.endsWith("/git/trees") ? new Response("{}", { status: 403 }) : null) });
    expect(await publishStatus({ token: GITHUB_TOKEN, repository: "duongnq2798/vestiarion", file, fetchImpl: refuseTrees.fetchImpl })).toEqual({ ok: false, step: "tree", status: 403 });
    const refuseRef = withGithub({ published: "{}", answer: (call) => (call.method === "PATCH" ? new Response("{}", { status: 409 }) : null) });
    expect(await publishStatus({ token: GITHUB_TOKEN, repository: "duongnq2798/vestiarion", file, fetchImpl: refuseRef.fetchImpl })).toEqual({ ok: false, step: "ref", status: 409 });
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await publishStatus({ token: GITHUB_TOKEN, repository: "duongnq2798/vestiarion", file, fetchImpl: down })).toEqual({ ok: false, step: "tree", status: 0 });
    expect(await publishStatus({ token: GITHUB_TOKEN, repository: "not a repository", file, fetchImpl: down })).toEqual({ ok: false, step: "repository", status: 0 });
  });

  it("reads the branch's history: none before the branch exists, unknown while GitHub does not answer, dropped when it is not one", async () => {
    const rounds = [statusRound([pass("/")], at(10, 0))];
    const good = JSON.stringify(statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS, rounds }));
    const ask = (fetchImpl: typeof fetch) => readPublished({ token: GITHUB_TOKEN, repository: "duongnq2798/vestiarion", fetchImpl });
    expect(await ask(withGithub({ published: good }).fetchImpl)).toEqual({ state: "read", rounds });
    expect(await ask(withGithub().fetchImpl)).toEqual({ state: "none", rounds: [] });
    expect(await ask(withGithub({ answer: () => new Response("{}", { status: 503 }) }).fetchImpl)).toEqual({ state: "unreachable", rounds: [] });
    expect(await ask(withGithub({ published: "{not json" }).fetchImpl)).toEqual({ state: "unreadable", rounds: [] });
    const reader = withGithub({ published: good });
    await ask(reader.fetchImpl);
    expect(reader.calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    // A 404 for the file of a branch that exists is not trusted to erase the history.
    const flaky = withGithub({ published: good, answer: (call) => (call.path.includes("/contents/") ? new Response("{}", { status: 404 }) : null) });
    expect(await ask(flaky.fetchImpl)).toEqual({ state: "unreachable", rounds: [] });
    expect(flaky.calls.map((call) => call.path)).toEqual(["/repos/duongnq2798/vestiarion/contents/status.json?ref=refs/heads/status", "/repos/duongnq2798/vestiarion/git/ref/heads/status"]);
  });

  it("keeps the README a table of text: no link, image or emphasis from a reason", () => {
    const file = statusFile({ origin: PRODUCTION_ORIGIN, everyMinutes: 10, checks: CHECKS.slice(0, 1), rounds: [statusRound([fail("/", "answered 302 (redirected to ![x](https://evil.example/a_b*c)), expected 200")], at(10, 0))] });
    expect(statusReadme(file)).toContain("| [/](https://www.vestiarion.xyz/) | Failed: answered 302 &#40;redirected to &#33;&#91;x&#93;&#40;https://evil.example/a&#95;b&#42;c&#41;&#41;, expected 200 |");
  });

  describe("the command with --publish-status", () => {
    /** A clock that moves only when the loop sleeps. */
    function fakeTime(start = at(10, 0).getTime()) {
      let now = start;
      return { clock: () => now, sleep: async (ms: number) => void (now += ms) };
    }
    const env = (origin: string) => ({ SYNTHETIC_ORIGIN: origin, MONITOR_DISCORD_WEBHOOK_URL: WEBHOOK, GITHUB_TOKEN, GITHUB_REPOSITORY: "duongnq2798/vestiarion" });

    it("goes on from the branch's last 7 days, publishes after every round, and never prints the token", async () => {
      const production = await serve();
      const earlier = [
        { at: new Date(at(10, 0).getTime() - 8 * DAY_MS).toISOString(), results: { "/": [1, 1] } },
        { at: at(9, 50).toISOString(), results: { "/": [0, 2, "answered 500, expected 200"] } },
      ];
      const github = withGithub({ published: JSON.stringify({ version: 1, rounds: earlier }) });
      const discord = withDiscord();
      const fetchImpl: typeof fetch = (input, init) => (String(input instanceof Request ? input.url : input).startsWith("https://api.github.com/") ? github.fetchImpl(input, init) : discord.fetchImpl(input, init));
      const time = fakeTime();
      const { log, text } = logger();
      const code = await main(["--loop", "--minutes", "20", "--every", "10", "--publish-status"], { env: env(production.origin), fetchImpl, log, clock: time.clock, sleep: time.sleep });
      expect(code).toBe(0);
      expect(text()).toContain("Read 2 published rounds back from the status branch.");
      expect(text()).toContain("Published the status to the status branch: 2 rounds.");
      expect(text()).toContain("Published the status to the status branch: 3 rounds.");
      const published = JSON.parse(github.published() ?? "{}");
      expect(published.rounds.map((round: { at: string }) => round.at)).toEqual(["2026-10-28T09:50:00.000Z", "2026-10-28T10:00:00.000Z", "2026-10-28T10:10:00.000Z"]);
      expect(Object.keys(published.rounds[2].results)).toEqual(CHECKS.map((check) => check.path));
      expect(published.everyMinutes).toBe(10);
      expectNoToken(text());
    });

    it("keeps rounds while GitHub does not answer the history's read, and publishes them all once it does", async () => {
      const production = await serve();
      let reads = 0;
      const github = withGithub({ answer: (call) => (call.method === "GET" && (reads += 1) <= 2 ? new Response("{}", { status: 502 }) : null) });
      const time = fakeTime();
      const { log, text } = logger();
      const code = await main(["--loop", "--minutes", "30", "--every", "10", "--publish-status"], { env: env(production.origin), fetchImpl: github.fetchImpl, log, clock: time.clock, sleep: time.sleep });
      expect(code).toBe(0);
      // The read when the run starts and the one before the first round's publish go unanswered; the second round's
      // read finds no branch yet, so both rounds are published together, then the third.
      expect(text()).toContain("::warning::GitHub did not answer the read of the published status: this round waits, and is published once it does (1 waiting).");
      expect(text()).toContain("Read 0 published rounds back from the status branch.");
      expect(text()).toContain("Published the status to the status branch: 2 rounds.");
      expect(text()).toContain("Published the status to the status branch: 3 rounds.");
      expect(JSON.parse(github.published() ?? "{}").rounds).toHaveLength(3);
    });

    it(`starts the history again after ${HISTORY_READS} unanswered reads, so a branch GitHub cannot read never keeps the page paused`, async () => {
      const production = await serve();
      const github = withGithub({ answer: (call) => (call.method === "GET" ? new Response("{}", { status: 502 }) : null) });
      const time = fakeTime();
      const { log, text } = logger();
      const code = await main(["--loop", "--minutes", "60", "--every", "10", "--publish-status"], { env: env(production.origin), fetchImpl: github.fetchImpl, log, clock: time.clock, sleep: time.sleep });
      expect(code).toBe(0);
      // The read when the run starts and 4 more wait; the 6th unanswered read starts the history from the 5 rounds waiting.
      expect(text()).toContain("(4 waiting)");
      expect(text()).toContain(`::warning::GitHub left ${HISTORY_READS} reads of the published status unanswered: its history starts again from this run.`);
      expect(text()).toContain("Published the status to the status branch: 5 rounds.");
      expect(text()).toContain("Published the status to the status branch: 6 rounds.");
    });

    it("warns and goes on when GitHub refuses a round, and never fails the run for it", async () => {
      const production = await serve();
      const github = withGithub({ answer: (call) => (call.method === "POST" ? new Response("{}", { status: 403 }) : null) });
      const { log, text } = logger();
      expect(await main(["--publish-status"], { env: env(production.origin), fetchImpl: github.fetchImpl, log })).toBe(0);
      expect(text()).toContain("::warning::GitHub did not take the status (tree, answered 403): every round is published again next round.");
      expectNoToken(text());
    });

    it("publishes nothing without the flag, or without a token, and says why", async () => {
      const production = await serve();
      const github = withGithub();
      expect(await main([], { env: env(production.origin), fetchImpl: github.fetchImpl, log: () => undefined })).toBe(0);
      const { log, text } = logger();
      expect(await main(["--publish-status"], { env: { ...env(production.origin), GITHUB_TOKEN: "" }, fetchImpl: github.fetchImpl, log })).toBe(0);
      expect(text()).toContain("::warning::--publish-status needs GITHUB_TOKEN and GITHUB_REPOSITORY: the checks run, and no status is published.");
      expect(github.calls).toEqual([]);
    });
  });
});

// ---- The workflow ----------------------------------------------------------------------------------------------

describe(".github/workflows/synthetic-check.yml (PC4, PC11, PC12)", () => {
  it("starts every hour on a digits-only minute, and by hand, and never on a push or a pull request", () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}schedule:\n {4}- cron: "\d+ \* \* \* \*"\n {2}workflow_dispatch:\n/m);
    expect(WORKFLOW).not.toMatch(/^ {2}(push|pull_request|pull_request_target|workflow_run):/m);
  });

  it("runs one at a time and never cancels a running check", () => {
    expect(WORKFLOW).toMatch(/^concurrency:\n {2}group: synthetic-check\n {2}cancel-in-progress: false\n/m);
  });

  it("loops every 10 minutes for less than its job may run, which is less than GitHub's 6 hours", () => {
    const run = /node scripts\/synthetic-check\.mjs --loop --minutes (\d+) --every (\d+) --state (\S+) --publish-status\n/.exec(WORKFLOW);
    const timeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(WORKFLOW)?.[1]);
    expect(run).not.toBeNull();
    const [, minutes, every] = run!.map(Number);
    expect(every).toBe(10);
    expect(minutes).toBe(345);
    expect(minutes + 5).toBeLessThanOrEqual(timeout);
    expect(timeout).toBeLessThanOrEqual(360);
  });

  it("restores the newest state and saves this run's under its own key, even after a failure or a cancel", () => {
    const statePath = /--state (\S+) --publish-status\n/.exec(WORKFLOW)?.[1];
    expect(statePath).toBe(".synthetic-state.json");
    expect(WORKFLOW).toContain(`uses: actions/cache/restore@${CACHE_COMMIT} # v4\n`);
    expect(WORKFLOW).toContain(`uses: actions/cache/save@${CACHE_COMMIT} # v4\n`);
    expect([...WORKFLOW.matchAll(/^ {10}path: (\S+)$/gm)].map((match) => match[1])).toEqual([statePath, statePath]);
    const keys = [...WORKFLOW.matchAll(/^ {10}key: (.+)$/gm)].map((match) => match[1]);
    expect(keys).toEqual(["synthetic-state-${{ github.run_id }}-${{ github.run_attempt }}", "synthetic-state-${{ github.run_id }}-${{ github.run_attempt }}"]);
    expect(WORKFLOW).toContain("restore-keys: synthetic-state-\n");
    expect(WORKFLOW).toMatch(/- name: Save the state for the next run\n {8}if: always\(\)\n {8}uses: actions\/cache\/save@[0-9a-f]{40} # v4/);
  });

  it("runs no action by a tag that could move: each one is pinned to a commit, and none is given the token", () => {
    const uses = [...WORKFLOW.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
    expect(uses).toEqual([`actions/cache/restore@${CACHE_COMMIT}`, `actions/cache/save@${CACHE_COMMIT}`]);
    expect(WORKFLOW).not.toMatch(/^\s+token:/m);
  });

  it("holds one secret, the Discord webhook, and the job's own token, which may write contents for the status branch alone", () => {
    expect([...WORKFLOW.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1])).toEqual(["MONITOR_DISCORD_WEBHOOK_URL"]);
    // The token reaches the script's step alone, as GITHUB_TOKEN; no other step or name gets it.
    expect([...WORKFLOW.matchAll(/github\.token|GITHUB_TOKEN|GH_TOKEN/g)].map((match) => match[0])).toEqual(["GITHUB_TOKEN", "github.token"]);
    expect(WORKFLOW).toContain("          GITHUB_TOKEN: ${{ github.token }}\n        run: node scripts/synthetic-check.mjs ");
    // Read for the workflow, write for its one job, and nothing else written (status page SP5).
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect([...WORKFLOW.matchAll(/^\s+([a-z-]+):\s*write\b/gm)].map((match) => match[1])).toEqual(["contents"]);
    expect(WORKFLOW).toMatch(/\n {4}permissions:\n {6}contents: write\n {4}steps:\n/);
  });

  it("publishes to the status branch alone, and names no other ref", () => {
    const script = read("scripts/synthetic-check.mjs");
    expect(STATUS_BRANCH).toBe("status");
    // The README's comment, the move, the make, and the history's read, which names the branch by its full ref.
    expect([...script.matchAll(/refs\/[^`"'\s,)]*/g)].map((match) => match[0])).toEqual([
      "refs/heads/status",
      "refs/heads/${STATUS_BRANCH}",
      "refs/heads/${STATUS_BRANCH}",
      "refs/heads/${STATUS_BRANCH}",
    ]);
    expect(script).not.toMatch(/refs\/(tags|heads\/main)/);
  });

  it("checks production, or in a fork only the deployment its SYNTHETIC_ORIGIN variable names", () => {
    expect(WORKFLOW).toContain("    if: github.repository == 'duongnq2798/vestiarion' || vars.SYNTHETIC_ORIGIN != ''\n");
    expect(WORKFLOW).toContain(`SYNTHETIC_ORIGIN: \${{ vars.SYNTHETIC_ORIGIN || '${PRODUCTION_ORIGIN}' }}\n`);
  });

  it("fetches the script alone, at the run's commit, with no token, and installs nothing, so the script uses Node's built-ins only", () => {
    expect(WORKFLOW).toContain(
      '      - name: Fetch the script\n        run: >-\n          curl --fail --silent --show-error --location --retry 3 --max-time 60 --create-dirs\n          --output scripts/synthetic-check.mjs\n          "https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_SHA}/scripts/synthetic-check.mjs"\n'
    );
    expect(WORKFLOW).not.toMatch(/npm|npx|setup-node|actions\/checkout/);
    const imports = [...read("scripts/synthetic-check.mjs").matchAll(/^import .+ from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
    expect(read("scripts/synthetic-check.mjs")).not.toMatch(/\bimport\(|require\(/);
  });
});

// ---- The owner's steps -----------------------------------------------------------------------------------------

describe("the owner's steps in the docs (PC3, PC4)", () => {
  const SPEC = "docs/superpowers/specs/2026-10-28-production-check-design.md";

  /** Where each doc speaks of the check, on one line: the whole spec, and the paragraph naming the workflow elsewhere. */
  const docs: Array<[string, string]> = [SPEC, "docs/self-hosting.md", "ARCHITECTURE.md"].map((file) => {
    const text = read(file);
    const start = file === SPEC ? 0 : text.indexOf("`.github/workflows/synthetic-check.yml`");
    const about = start === -1 ? "" : file === SPEC ? text : text.slice(start, text.indexOf("\n\n", start));
    return [file, about.replace(/\s+/g, " ")];
  });

  it("say to cancel the older run, never the one just started, and none when that one started at once", () => {
    for (const [file, text] of docs) {
      expect(text, file).toMatch(/cancel(s|ling)? the older run in progress, not the one (you )?just started/);
      expect(text, file).toContain("cancel nothing");
    }
  });

  it("say that a deployed copy edit reaches the running checks only with a newer run, the old text until then", () => {
    for (const [file, text] of docs) expect(text, file).toContain("the old text");
  });
});
