import type { Vestiarion } from "@vestiarion/sdk";
import { clientFor, describeSource, maskKey, resolveCredentials, type Credentials } from "./auth.js";
import { apiFailure, CliError, EXIT, usageError } from "./errors.js";
import type { Io } from "./io.js";
import { json } from "./output.js";

export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  /** The value's placeholder in help, such as `<id>`. */
  value?: string;
  help: string;
  /** Listed in help as required, and refused when missing. */
  required?: boolean;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Command {
  path: string[];
  /** The positional arguments, as help writes them: `<id>`, `<export.json>`. */
  args?: string[];
  summary: string;
  /** Paragraphs under the usage line. */
  description?: string[];
  options?: Record<string, OptionSpec>;
  examples?: string[];
  /** Runs without an API key, or any network. */
  offline?: boolean;
  run(ctx: Context): Promise<number | void>;
}

/** What a write sends, shown before it is sent. */
export interface WritePreview {
  method: "POST";
  path: string;
  body: unknown;
  /** `null`: the operation takes none. `undefined`: the SDK makes a fresh one for this run. */
  idempotencyKey: string | null | undefined;
  /** What happens once it is added, in a sentence or two. */
  then: string;
}

export class Context {
  constructor(
    readonly io: Io,
    readonly command: Command,
    readonly values: Values,
    readonly args: string[]
  ) {}

  get json(): boolean {
    return this.values.json === true;
  }

  out(text: string): void {
    this.io.stdout(text);
  }

  /** Writes the API's answer as JSON with `--json`, else the text `render` makes of it. */
  print<T>(answer: T, render: (answer: T) => string): number {
    this.out(this.json ? json(answer) : render(answer));
    return EXIT.OK;
  }

  string(name: string): string | undefined {
    const value = this.values[name];
    return typeof value === "string" ? value : undefined;
  }

  /** A required option's value, or a usage error naming it. */
  need(name: string): string {
    const value = this.string(name);
    if (value === undefined || value.trim() === "") throw usageError(`--${name} is required. Run \`vestiarion ${this.command.path.join(" ")} --help\`.`);
    return value;
  }

  /** A whole number option, such as `--limit`. */
  count(name: string): number | undefined {
    const value = this.string(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value) || Number(value) < 1) throw usageError(`--${name} must be a whole number, 1 or more.`);
    return Number(value);
  }

  private resolved?: Credentials;

  credentials(): Credentials {
    this.resolved ??= resolveCredentials(
      { "api-key": this.string("api-key"), "base-url": this.string("base-url"), profile: this.string("profile") },
      this.io
    );
    return this.resolved;
  }

  client(): Vestiarion {
    return clientFor(this.credentials(), this.io);
  }

  /** Runs one API call, turning an API failure into the CLI's message and exit code. */
  async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw apiFailure(error);
    }
  }

  /**
   * Shows what a write will send and asks before sending it. `--yes` skips the question. Without a terminal to ask
   * in, and without `--yes`, nothing is sent.
   */
  async confirmWrite(preview: WritePreview): Promise<void> {
    if (this.values.yes === true) return;
    const credentials = this.credentials();
    const key = preview.idempotencyKey === null
      ? "none: this operation keeps no outcome for one"
      : preview.idempotencyKey === undefined
        ? "a new one for this run (pass --idempotency-key with your own record's id to make a rerun safe)"
        : preview.idempotencyKey;
    this.io.stderr(
      [
        `${preview.method} ${credentials.baseUrl}${preview.path}`,
        `Key: ${maskKey(credentials.apiKey)} (from ${describeSource(credentials)})`,
        `Idempotency-Key: ${key}`,
        JSON.stringify(preview.body, null, 2),
        preview.then,
        "",
      ].join("\n")
    );
    if (!this.io.stdinIsTTY) {
      throw new CliError(EXIT.FAILED, "Nothing was sent: there is no terminal to confirm in. Pass --yes to send it without asking.");
    }
    if (!(await this.io.confirm("Send it? [y/N] "))) throw new CliError(EXIT.FAILED, "Nothing was sent.");
  }
}

/** The options every list shares. */
export const PAGE_OPTIONS: Record<string, OptionSpec> = {
  limit: { type: "string", value: "<n>", help: "How many to return per page, up to 200 (the API's default is 50)" },
  cursor: { type: "string", value: "<cursor>", help: "Continue from a page's next cursor" },
  all: { type: "boolean", help: "Read every page, from --cursor on" },
};

/** The options every write shares. */
export const WRITE_OPTIONS: Record<string, OptionSpec> = {
  "idempotency-key": { type: "string", value: "<key>", help: "Your own record's id, so a rerun cannot add it twice" },
  yes: { type: "boolean", short: "y", help: "Send without asking" },
};
