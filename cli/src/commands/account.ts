import { DEFAULT_BASE_URL, type Status, type Treasury } from "@vestiarion/sdk";
import { clientFor, describeSource, maskKey, resolveBaseUrl } from "../auth.js";
import type { Command } from "../command.js";
import { configPath, profileName, readConfig, writeConfig } from "../config.js";
import { apiFailure, CliError, usageError } from "../errors.js";
import { pairs } from "../output.js";

/** The workspace's network, from its operating account's chain: where the agent pays from. */
export function networkOf(treasury: Treasury): { chain: string; label: string } | null {
  const chain = treasury.accounts.find((account) => account.kind === "operating")?.chain;
  if (!chain) return null;
  const label = chain === "ARC" ? "Arc mainnet" : chain === "ARC-TESTNET" ? "Arc testnet" : chain;
  return { chain, label };
}

const STDIN = { type: "boolean", help: "Read the key from stdin instead of a hidden prompt" } as const;

export const ACCOUNT_COMMANDS: Command[] = [
  {
    path: ["login"],
    summary: "Check an API key with one read, then save it for a profile",
    description: [
      "Reads the key from a hidden prompt, or from stdin with --stdin, so it never sits in your shell history. It checks the key with GET /api/v1/status, a read that changes nothing, and saves it only if the API accepts it.",
      "The key is saved in your user config file, %APPDATA%\\vestiarion\\config.json on Windows and $XDG_CONFIG_HOME/vestiarion/config.json (or ~/.config/vestiarion/config.json) elsewhere, readable by you alone: mode 0600 where the system has file modes, and on Windows your user profile's permissions, which let only you, administrators and the system read it.",
      "The profile keeps the API the key was checked against, and the key is sent to no other: for another --base-url or VESTIARION_BASE_URL, log in again under another profile.",
      "Create a key on the workspace's Settings page, under API keys.",
    ],
    options: { stdin: STDIN },
    examples: ["vestiarion login", "vestiarion login --profile staging --base-url https://staging.example.com", "printf '%s' \"$KEY\" | vestiarion login --stdin"],
    async run(ctx) {
      if (ctx.string("api-key") !== undefined) {
        throw usageError("login reads the key from a hidden prompt, or from stdin with --stdin, so that it stays out of your shell history: leave out --api-key.");
      }
      const profile = profileName(ctx.string("profile"), ctx.io);
      const file = configPath(ctx.io);
      const config = readConfig(file);
      const baseUrl = resolveBaseUrl({ "base-url": ctx.string("base-url") }, ctx.io, config.profiles[profile]?.baseUrl);
      let key: string;
      if (ctx.values.stdin === true) key = (await ctx.io.readStdin()).trim();
      else if (ctx.io.stdinIsTTY) key = (await ctx.io.readHidden(`API key for profile "${profile}": `)).trim();
      else throw usageError("There is no terminal to type the key in: pipe it in with --stdin.");
      if (!key) throw usageError("No key was given: nothing was saved.");

      const client = clientFor({ apiKey: key, baseUrl }, ctx.io);
      let status: Status;
      try {
        status = await client.status.get();
      } catch (error) {
        const failure = apiFailure(error);
        if (failure instanceof CliError) throw new CliError(failure.exitCode, `${failure.message} Nothing was saved.`);
        throw failure;
      }
      config.profiles[profile] = {
        apiKey: key,
        ...(baseUrl !== DEFAULT_BASE_URL ? { baseUrl } : {}),
        workspace: status.businessName,
        savedAt: new Date().toISOString(),
      };
      writeConfig(file, config);
      const saved = { profile, workspace: status.businessName, key: maskKey(key), baseUrl, configFile: file };
      return ctx.print(saved, () => `Saved ${saved.key} for ${saved.workspace} as profile "${profile}", in ${file}.\n`);
    },
  },
  {
    path: ["logout"],
    summary: "Remove a profile's saved key from this computer",
    description: [
      "The key itself keeps working until an owner or an admin revokes it, on the workspace's Settings page under API keys.",
    ],
    examples: ["vestiarion logout", "vestiarion logout --profile staging"],
    offline: true,
    async run(ctx) {
      const profile = profileName(ctx.string("profile"), ctx.io);
      const file = configPath(ctx.io);
      const config = readConfig(file);
      const saved = config.profiles[profile];
      if (!saved) return ctx.print({ profile, removed: false }, () => `No key is saved for profile "${profile}": nothing to remove.\n`);
      delete config.profiles[profile];
      writeConfig(file, config);
      return ctx.print({ profile, removed: true, key: maskKey(saved.apiKey) }, (answer) =>
        `Removed ${answer.key} (profile "${profile}") from ${file}. The key still works until it is revoked in Settings, under API keys.\n`
      );
    },
  },
  {
    path: ["whoami"],
    summary: "The key's workspace and network, and where the key came from",
    description: [
      "GET /api/v1/status and GET /api/v1/treasury. The network is the chain of the workspace's operating account: ARC-TESTNET is Arc testnet, ARC is Arc mainnet.",
      "The API does not say whether a key may also add records: Settings lists each key as Read only or Read and write, and a write with a read-only key answers 403.",
    ],
    async run(ctx) {
      const credentials = ctx.credentials();
      const client = ctx.client();
      const [status, treasury] = await ctx.call(() => Promise.all([client.status.get(), client.treasury.get()]));
      const network = networkOf(treasury);
      const answer = {
        workspace: status.businessName,
        network,
        key: { prefix: maskKey(credentials.apiKey), source: credentials.source, ...(credentials.source === "profile" ? { profile: credentials.profile } : {}) },
        baseUrl: credentials.baseUrl,
        payments: status.provenance.payments,
        lastCycleAt: status.clock.lastCycleAt,
      };
      return ctx.print(answer, () =>
        pairs([
          ["Workspace", status.businessName],
          ["Network", network ? `${network.label} (${network.chain})` : "not reported: the workspace has no operating account"],
          ["Payments", status.provenance.payments],
          ["Last cycle", status.clock.lastCycleAt ?? "none yet"],
          ["Key", `${answer.key.prefix} (from ${describeSource(credentials)})`],
          ["API", credentials.baseUrl],
        ])
      );
    },
  },
  {
    path: ["status"],
    summary: "What the workspace can do now: payments, yield, screening, its clock and totals",
    description: ["GET /api/v1/status. Check Payments before treating a paid bill as money that moved: simulate and unavailable move none."],
    async run(ctx) {
      const status = await ctx.call(() => ctx.client().status.get());
      return ctx.print({ data: status }, ({ data: s }) =>
        pairs([
          ["Workspace", s.businessName],
          ["Payments", s.provenance.payments],
          ["Yield", s.provenance.yield],
          ["Screening", s.provenance.screening],
          ["Clock", `${s.clock.mode}, day ${s.clock.day}`],
          ["Last cycle", s.clock.lastCycleAt ?? "none yet"],
          ["Decisions", `${s.totals.decisionsLogged} logged, ${s.totals.flagged} flagged`],
          ["Paid out", `${s.totals.totalPaidOut} USDC`],
          ["API", s.apiVersion],
        ])
      );
    },
  },
];

