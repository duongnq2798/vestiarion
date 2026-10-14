#!/usr/bin/env node
import { nodeIo } from "./io.js";
import { run } from "./main.js";

// A reader that stops early, such as `vestiarion ledger list | head`, is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

process.exitCode = await run(process.argv.slice(2), nodeIo());
