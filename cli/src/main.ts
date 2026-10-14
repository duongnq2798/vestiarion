import { parseArgs } from "node:util";
import { Context, type Command, type OptionSpec, type Values } from "./command.js";
import { ACCOUNT_COMMANDS } from "./commands/account.js";
import { RECORD_COMMANDS } from "./commands/records.js";
import { VERIFY_COMMANDS } from "./commands/verify.js";
import { CliError, EXIT, usageError } from "./errors.js";
import type { Io } from "./io.js";
import { VERSION } from "./version.js";

/** Options every command takes. */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  "api-key": { type: "string", value: "<key>", help: "The API key for this run; a flag stays in your shell history, so prefer VESTIARION_API_KEY or login" },
  profile: { type: "string", value: "<name>", help: "The saved profile to use (default: VESTIARION_PROFILE, else default)" },
  "base-url": { type: "string", value: "<url>", help: "The API's origin (default: VESTIARION_BASE_URL, else https://www.vestiarion.xyz)" },
  json: { type: "boolean", help: "Print the API's answer as JSON, for scripts" },
  help: { type: "boolean", short: "h", help: "Show help" },
  version: { type: "boolean", short: "v", help: "Print the CLI's version" },
};

export const COMMANDS: Command[] = [...ACCOUNT_COMMANDS, ...RECORD_COMMANDS, ...VERIFY_COMMANDS];

/** The help's sections: each group of commands with a line about it. */
const GROUPS: Array<{ title: string; names: Array<[string, string]> }> = [
  {
    title: "Account",
    names: [
      ["login", "Check an API key with one read, then save it for a profile"],
      ["logout", "Remove a profile's saved key from this computer"],
      ["whoami", "The key's workspace and network, and where the key came from"],
      ["status", "Payments, yield, screening, the clock and totals"],
    ],
  },
  {
    title: "Records",
    names: [
      ["bills", "Payables, the bills the business pays: list, show, add"],
      ["invoices", "Receivables, what the business is owed: list, show, create"],
      ["counterparties", "Vendors, clients and contractors: list, show, add"],
      ["milestones", "Contractor milestones: list, show, add"],
      ["payee-links", "One-time links for a payee's address: create"],
      ["decisions", "The agent's decisions, with its reasoning: list, show"],
      ["treasury", "Accounts, reserve, obligations and the latest forecast"],
      ["insights", "The latest transfers, cycle runs and screenings"],
    ],
  },
  {
    title: "Ledger and webhooks",
    names: [
      ["ledger", "The signed audit chain: list, check, and verify an export offline"],
      ["webhooks", "Verify a delivery's signature offline"],
    ],
  },
];

const DOCS = "https://www.vestiarion.xyz/docs/get-started/cli";
const EXIT_CODES = "Exit codes: 0 done, 1 usage error, 2 API error, failed check or refused write, 3 no key or a key the API refused.";

function optionLines(options: Record<string, OptionSpec>): string[] {
  const rows = Object.entries(options).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : "    "}--${name}${spec.value ? ` ${spec.value}` : ""}`;
    const notes = [spec.required ? "required" : "", spec.multiple ? "repeatable" : ""].filter(Boolean).join(", ");
    return [flag, `${spec.help}${notes ? ` (${notes})` : ""}`];
  });
  const width = Math.max(...rows.map(([flag]) => flag.length));
  return rows.map(([flag, help]) => `  ${flag.padEnd(width)}  ${help}`);
}

export function mainHelp(): string {
  const width = Math.max(...GROUPS.flatMap((group) => group.names.map(([name]) => name.length)));
  const lines = [
    `vestiarion ${VERSION}: the Vestiarion API from a terminal`,
    "",
    "Usage: vestiarion <command> [options]",
    "",
  ];
  for (const group of GROUPS) {
    lines.push(group.title);
    for (const [name, summary] of group.names) lines.push(`  ${name.padEnd(width)}  ${summary}`);
    lines.push("");
  }
  lines.push("Options", ...optionLines(GLOBAL_OPTIONS), "");
  lines.push(
    "The key comes from --api-key, else VESTIARION_API_KEY, else the profile `vestiarion login` saved.",
    "Writes show what they will send and ask first; --yes sends without asking.",
    EXIT_CODES,
    "",
    "Run `vestiarion <command> --help` for a command's options. Docs: " + DOCS,
    ""
  );
  return lines.join("\n");
}

function usageLine(command: Command): string {
  const required = Object.entries(command.options ?? {})
    .filter(([, spec]) => spec.required)
    .map(([name, spec]) => `--${name} ${spec.value ?? ""}`.trim());
  return ["vestiarion", ...command.path, ...(command.args ?? []), ...required, "[options]"].join(" ");
}

export function commandHelp(command: Command): string {
  const lines = [`${command.summary}.`, "", `Usage: ${usageLine(command)}`, ""];
  for (const paragraph of command.description ?? []) lines.push(paragraph, "");
  if (command.options && Object.keys(command.options).length > 0) lines.push("Options", ...optionLines(command.options), "");
  lines.push("Global options", ...optionLines(GLOBAL_OPTIONS), "");
  if (command.examples?.length) lines.push("Examples", ...command.examples.map((example) => `  ${example}`), "");
  lines.push(EXIT_CODES, "");
  return lines.join("\n");
}

export function groupHelp(group: string): string {
  const commands = COMMANDS.filter((command) => command.path[0] === group && command.path.length > 1);
  const width = Math.max(...commands.map((command) => command.path.join(" ").length + 11));
  const lines = [`Usage: vestiarion ${group} <command> [options]`, "", "Commands"];
  for (const command of commands) lines.push(`  ${`vestiarion ${command.path.join(" ")}`.padEnd(width)}  ${command.summary}`);
  lines.push("", `Run \`vestiarion ${group} <command> --help\` for its options.`, "");
  return lines.join("\n");
}

const isGroup = (name: string) => COMMANDS.some((command) => command.path.length > 1 && command.path[0] === name);

function findCommand(positionals: string[]): Command | undefined {
  return (
    COMMANDS.find((command) => command.path.length === 2 && command.path[0] === positionals[0] && command.path[1] === positionals[1]) ??
    COMMANDS.find((command) => command.path.length === 1 && command.path[0] === positionals[0])
  );
}

type ParseOptions = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function parseOptions(options: Record<string, OptionSpec>): ParseOptions {
  return Object.fromEntries(
    Object.entries(options).map(([name, spec]) => [name, { type: spec.type, ...(spec.short ? { short: spec.short } : {}), ...(spec.multiple ? { multiple: true } : {}) }])
  ) as ParseOptions;
}

/** Every option any command takes, so a first, lenient pass can tell an option's value from the command's words. */
function everyOption(): Record<string, OptionSpec> {
  const all: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS };
  for (const command of COMMANDS) Object.assign(all, command.options);
  return all;
}

/** node:util's message, without its advice about `--`, which is not how this CLI is used. */
function parseMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\. To specify/)[0].replace(/\.?$/, ".");
}

/**
 * Runs one command line and returns its exit code. Nothing here exits the process or reads `process`: the terminal,
 * the environment and the network come from `io`.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  let json = argv.includes("--json");
  try {
    const loose = parseArgs({ args: argv, options: parseOptions(everyOption()), strict: false, allowPositionals: true });
    json = loose.values.json === true;
    const words = loose.positionals;

    if (words[0] === "help") {
      const topic = words.slice(1);
      const command = topic.length > 0 ? findCommand(topic) : undefined;
      if (command && command.path.length === topic.length) io.stdout(commandHelp(command));
      else if (topic.length === 1 && isGroup(topic[0])) io.stdout(groupHelp(topic[0]));
      else if (topic.length === 0) io.stdout(mainHelp());
      else throw usageError(`There is no command "${topic.join(" ")}". Run \`vestiarion --help\` for the commands.`);
      return EXIT.OK;
    }
    if (words.length === 0) {
      io.stdout(loose.values.version === true && loose.values.help !== true ? `${VERSION}\n` : mainHelp());
      return EXIT.OK;
    }

    const command = findCommand(words);
    if (!command || (command.path.length === 1 && isGroup(words[0]))) {
      if (isGroup(words[0]) && (words.length === 1 || loose.values.help === true)) {
        io.stdout(groupHelp(words[0]));
        return EXIT.OK;
      }
      const tried = isGroup(words[0]) ? `${words[0]} ${words[1]}` : words[0];
      throw usageError(`There is no command "${tried}". Run \`vestiarion --help\` for the commands.`);
    }

    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({ args: argv, options: parseOptions({ ...GLOBAL_OPTIONS, ...command.options }), strict: true, allowPositionals: true }) as typeof parsed;
    } catch (error) {
      throw usageError(`${parseMessage(error)} Run \`vestiarion ${command.path.join(" ")} --help\` for its options.`);
    }
    if (parsed.values.help === true) {
      io.stdout(commandHelp(command));
      return EXIT.OK;
    }
    if (parsed.values.version === true) {
      io.stdout(`${VERSION}\n`);
      return EXIT.OK;
    }
    const args = parsed.positionals.slice(command.path.length);
    const expected = command.args ?? [];
    if (args.length !== expected.length) {
      const what = expected.length === 0 ? "takes no arguments" : `takes ${expected.join(" ")}`;
      throw usageError(`\`vestiarion ${command.path.join(" ")}\` ${what}. Run \`vestiarion ${command.path.join(" ")} --help\`.`);
    }
    return (await command.run(new Context(io, command, parsed.values, args))) ?? EXIT.OK;
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError(EXIT.FAILED, error instanceof Error ? error.message : String(error));
    io.stderr(json ? `${JSON.stringify({ error: { message: failure.message, exitCode: failure.exitCode } })}\n` : `Error: ${failure.message}\n`);
    return failure.exitCode;
  }
}
