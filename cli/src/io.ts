import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { FetchLike } from "@vestiarion/sdk";
import { CliError, EXIT } from "./errors.js";

/**
 * Everything a run touches outside its arguments: the environment, the terminal and the network. `nodeIo` is the real
 * one; tests pass their own, with a recorded `fetch` and no terminal.
 */
export interface Io {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether a person can answer a prompt: stdin is a terminal. */
  stdinIsTTY: boolean;
  /** All of stdin, as text. */
  readStdin(): Promise<string>;
  /** One line typed without echo, for a key. */
  readHidden(prompt: string): Promise<string>;
  /** A yes or no from the terminal; anything but y or yes is no. */
  confirm(prompt: string): Promise<boolean>;
  /** The API's transport. Defaults to the runtime's `fetch`. */
  fetch?: FetchLike;
  /** How many times the SDK retries a failed request. Defaults to the SDK's own. */
  maxRetries?: number;
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);

function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: CliError) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    // Raw mode: the terminal echoes nothing, and each key press arrives as typed (a paste arrives whole).
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === CTRL_D) return finish();
        if (char === CTRL_C) return finish(new CliError(EXIT.FAILED, "Cancelled: nothing was saved."));
        if (BACKSPACE.has(char)) value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    let answered = false;
    // stdin ending before an answer (Ctrl-D) is a no.
    rl.on("close", () => {
      if (!answered) {
        process.stderr.write("\n");
        resolve(false);
      }
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function nodeIo(): Io {
  return {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin,
    readHidden,
    confirm,
  };
}
