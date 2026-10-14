import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FetchLike } from "@vestiarion/sdk";
import type { Io } from "../../cli/src/io";
import { run } from "../../cli/src/main";

/** An invented key, well formed, whose secret is easy to look for in output. */
export const KEY = `vxk_abcdefgh_${"S3cr3t".repeat(7)}x`;
export const SECRET = KEY.slice("vxk_abcdefgh_".length);
export const OTHER_KEY = `vxk_zyxwvuts_${"Other".repeat(8)}abc`;
export const THIRD_KEY = `vxk_mnopqrst_${"Third".repeat(8)}abc`;

/** A recorded answer from content/docs/examples, the shapes the docs and the OpenAPI document are held to. */
export function recorded(name: string): { data: unknown; page?: unknown } {
  return JSON.parse(readFileSync(path.join("content", "docs", "examples", `${name}.json`), "utf8"));
}

export interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
type Route = Answer | ((url: URL, sent: Sent) => Answer);

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  tty?: boolean;
  /** What a person answers to a confirmation. */
  answer?: boolean;
  stdin?: string;
  /** What a person types at the hidden prompt. */
  typed?: string;
  /** Answers by `METHOD /path`. A request with no route answers 404, and a route throwing is a network failure. */
  routes?: Record<string, Route>;
}

/** The CLI's `run` with a recorded network, a temporary home and no terminal unless asked for. */
export function harness(options: HarnessOptions = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "vestiarion-cli-"));
  const sent: Sent[] = [];
  const prompts: string[] = [];
  let stdout = "";
  let stderr = "";
  const fetch: FetchLike = async (url, init) => {
    const request: Sent = { method: init.method, url, headers: init.headers, body: init.body };
    sent.push(request);
    const parsed = new URL(url);
    const route = options.routes?.[`${init.method} ${parsed.pathname}`];
    const answer: Answer = route === undefined ? { status: 404, body: { error: { code: "not_found", message: "Not found." } } } : typeof route === "function" ? route(parsed, request) : route;
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    const headers = new Headers(answer.headers);
    return { status: answer.status, headers, text: async () => text };
  };
  const io: Io = {
    env: { XDG_CONFIG_HOME: path.join(home, "xdg"), APPDATA: path.join(home, "roaming"), ...options.env },
    platform: options.platform ?? "linux",
    homedir: home,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    stdinIsTTY: options.tty ?? false,
    readStdin: async () => options.stdin ?? "",
    readHidden: async (prompt) => {
      prompts.push(prompt);
      return options.typed ?? "";
    },
    confirm: async (prompt) => {
      prompts.push(prompt);
      return options.answer ?? false;
    },
    fetch,
    maxRetries: 0,
  };
  return {
    io,
    home,
    sent,
    prompts,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    run: (...argv: string[]) => run(argv, io),
  };
}

export type Harness = ReturnType<typeof harness>;
