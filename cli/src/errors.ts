import { VestiarionError } from "@vestiarion/sdk";

/**
 * How a run ends, for a script to branch on:
 * - 0: done;
 * - 1: a usage error: an unknown command or option, a missing argument, a value the CLI cannot read;
 * - 2: the API answered with an error, a check did not pass, or the CLI refused to send a write;
 * - 3: no key, a key that is not a Vestiarion key, or one the API refused (401 or 403).
 */
export const EXIT = { OK: 0, USAGE: 1, FAILED: 2, AUTH: 3 } as const;

/** A run that ends with `exitCode`, after printing `message` to stderr. */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(EXIT.USAGE, message);

/** An API failure as the CLI reports it: the API's own message, its status and code, and the exit code its kind earns. */
export function apiFailure(error: unknown): unknown {
  if (!(error instanceof VestiarionError)) return error;
  const where = error.status > 0 ? `HTTP ${error.status} ${error.code}` : error.code;
  const retry = error.retryAfter !== null ? ` Retry after ${error.retryAfter} s.` : "";
  const exitCode = error.status === 401 || error.status === 403 ? EXIT.AUTH : EXIT.FAILED;
  return new CliError(exitCode, `${error.message} (${where})${retry}`);
}
