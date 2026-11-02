import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command, Context, OptionSpec } from "../command.js";
import { CliError, EXIT, usageError } from "../errors.js";
import { checkEvidenceFile, describe, keyIdsOf, outputPath, plain, size, totalsLine, type Document } from "../evidence-file.js";

/**
 * Evidence and close packs (docs/superpowers/specs/2026-11-02-cli-evidence-close-pack-design.md): export one through the
 * API as the workspace's download gives it, and check one offline with the SDK's `verifyEvidence`.
 */

const SUBJECTS = ["bill", "milestone", "receipt", "payee-lock"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const FILE_OPTIONS: Record<string, OptionSpec> = {
  out: { type: "string", value: "<file>", help: "Save it here instead, or - to print it (default: the name the workspace gives its download)" },
  force: { type: "boolean", help: "Replace a file that is already there" },
};

const KEY_OPTION: Record<string, OptionSpec> = {
  "public-key": { type: "string", multiple: true, value: "<key.pem>", help: "Check against this public key instead of the keys the file carries" },
};

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {});
const quoted = (file: string) => (/\s/.test(file) ? `"${file}"` : file);

/**
 * Refuses an `--out` that cannot be written before anything is sent, so no evidence read is spent on it (CE3): a folder,
 * a file in a folder that is not there, or a file that is there without --force.
 */
function plannedOut(ctx: Context): string | undefined {
  const out = ctx.string("out");
  if (out === undefined) return undefined;
  if (out.trim() === "" || /[\\/]$/.test(out)) throw usageError("--out names a file, or - to print the document.");
  if (out === "-") return out;
  const target = path.resolve(ctx.io.cwd, out);
  const folder = path.dirname(target);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw usageError(`${path.dirname(out)} is not a folder that is there, so ${out} cannot be saved.`);
  if (existsSync(target)) {
    if (statSync(target).isDirectory()) throw usageError(`${out} is a folder. Name a file in it, such as ${path.join(out, "evidence.json")}.`);
    if (ctx.values.force !== true) throw usageError(`${out} is already there. Pass --force to replace it, or --out to name another file.`);
  }
  return out;
}

/**
 * The document as printed by `--out -`: every character outside ASCII written as a JSON escape. It parses to the same
 * document, so it verifies, and a shell that re-encodes what it captures, as Windows PowerShell 5.1's `>` does through
 * the console's code page, cannot change it.
 */
function asciiJson(content: string): string {
  return content.replace(/[^\x00-\x7f]/g, (char) => `${String.fromCharCode(92)}u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** What the file holds, in one line, by format (CE5). */
function holds(document: Document): string[] {
  if (document.format === "vestiarion-evidence/1") {
    const subject = fields(document.subject);
    const amount = typeof subject.amount === "number" ? `${subject.amount} ${plain(subject.currency)}` : "";
    return [`${describe(document)}: ${[plain(subject.payee), amount, plain(subject.status)].filter(Boolean).join(", ")}`];
  }
  if (document.format === "vestiarion-receipt/1") {
    if (document.ready === true) {
      const facts = fields(document.facts);
      return [`${describe(document)}: ready, ${plain(String(facts.amount ?? ""))} ${plain(facts.token)} paid ${plain(facts.paidAt).slice(0, 10)}, transaction ${plain(facts.txHash)}`];
    }
    const notReady = fields(document.notReady);
    return [`${describe(document)}: not ready (${plain(notReady.code)}): ${plain(notReady.reason)}`];
  }
  if (document.format === "vestiarion-payee-lock-evidence/1") {
    const changes = Array.isArray(document.changes) ? document.changes.length : 0;
    return [`${describe(document)}: ${changes} address change${changes === 1 ? "" : "s"}`];
  }
  const totals = fields(document.totals);
  const lines = [`${describe(document)}: on chain, ${totalsLine(totals.onChain)}`];
  if (Array.isArray(totals.simulated) && totals.simulated.length > 0) lines.push(`Simulated, which moved nothing on chain: ${totalsLine(totals.simulated)}`);
  if (document.cut === true) lines.push("The month holds more than 2,000 payments, and the pack stops at 2,000.");
  const unread = (Array.isArray(document.unread) ? document.unread : []).map(plain).filter(Boolean);
  if (unread.length > 0) lines.push(`Could not be read just now, so the pack leaves it out: ${unread.join(", ")}.`);
  return lines;
}

/** The parts of the document `--json` adds beside the file, by format (CE5). */
function jsonParts(document: Document): Fields {
  if (document.format === "vestiarion-evidence/1") return { subject: document.subject };
  if (document.format === "vestiarion-receipt/1") return { ready: document.ready, notReady: document.notReady };
  if (document.format === "vestiarion-payee-lock-evidence/1") {
    return { period: document.period, changes: Array.isArray(document.changes) ? document.changes.length : 0 };
  }
  return { month: document.month, cut: document.cut, unread: document.unread, totals: document.totals };
}

/** The target was already there, and --force was not passed. */
class Taken extends Error {}

/**
 * Writes `content` to `target` whole or not at all (CE3). It goes to a new file beside the target first, then is renamed
 * onto it, so a failed write leaves neither a short file nor, with --force, a truncated one. Without --force the target's
 * name is claimed first with `wx`, so a file that is there, or one made meanwhile, is never replaced.
 */
function writeWhole(target: string, content: string, force: boolean): void {
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  let claimed = false;
  try {
    if (!force) {
      try {
        closeSync(openSync(target, "wx"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Taken();
        throw error;
      }
      claimed = true;
    }
    writeFileSync(temp, content, { flag: "wx" });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    if (claimed) rmSync(target, { force: true });
    throw error;
  }
}

/** Writes the document as the workspace's download does, and says what it holds (CE2, CE3, CE5). */
function save(ctx: Context, document: Document, out: string | undefined, verify: string): number {
  const content = JSON.stringify(document, null, 2);
  const target = outputPath(ctx.io.cwd, out, document);
  if (target === "-") {
    ctx.out(`${asciiJson(content)}\n`);
    return EXIT.OK;
  }
  try {
    writeWhole(target, content, ctx.values.force === true);
  } catch (error) {
    const named = path.relative(ctx.io.cwd, target) || target;
    if (error instanceof Taken) throw usageError(`${named} is already there. Pass --force to replace it, or --out to name another file.`);
    throw new CliError(EXIT.FAILED, `${named} could not be written (${(error as Error).message}).`);
  }
  const relative = path.relative(ctx.io.cwd, target);
  const file = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
  const bytes = Buffer.byteLength(content);
  const entries = Array.isArray(document.entries) ? document.entries.length : 0;
  const keyIds = keyIdsOf(document);
  const network = fields(document.network);
  const answer = { file, bytes, format: document.format, workspace: document.workspace, network: document.network, entries, keyIds, ...jsonParts(document) };
  return ctx.print(answer, () =>
    [
      `Saved ${file} (${size(bytes)})`,
      ...holds(document),
      `${plain(network.label) || "Its network"}: ${entries} signed entr${entries === 1 ? "y" : "ies"}, key${keyIds.length === 1 ? "" : "s"} ${keyIds.join(", ") || "none"}`,
      `Check it offline: vestiarion ${verify} ${quoted(file)} --public-key <key.pem>, with the key from the workspace's Audit log page.`,
      "",
    ].join("\n")
  );
}

async function verifyRun(ctx: Context, expected?: "vestiarion-close-pack/1"): Promise<number> {
  const pins = (ctx.values["public-key"] as string[] | undefined) ?? [];
  const result = await checkEvidenceFile(ctx.io.cwd, ctx.args[0], pins, expected);
  ctx.print(result.answer, () => `${result.lines.join("\n")}\n`);
  return result.verdict === "valid" ? EXIT.OK : EXIT.FAILED;
}

const VERIFY_DESCRIPTION = [
  "Needs no key and no network. It is the SDK's verifyEvidence: every entry the file carries is checked (its body hash, its Ed25519 signature and its chain hash), every entry a fact cites must be carried, two entries in a row must link, and every copy of an entry's hash must be the entry's.",
  "Exits 0 when VALID, and 2 when BROKEN or NOT CHECKED.",
  "It names the keys that signed the entries. Without --public-key the file vouches for itself: compare the signing key's id with the workspace's Audit log page, or pass the public key you trust. Across a key rotation, pass every key: repeat --public-key, or put the PEM blocks in one file.",
];

export const EVIDENCE_COMMANDS: Command[] = [
  {
    path: ["evidence", "export"],
    summary: "Save a payment's evidence, a bill's receipt or the payee lock's evidence as a signed file",
    description: [
      "One of: --bill, GET /api/v1/invoices/{id}/evidence; --milestone, GET /api/v1/milestones/{id}/evidence; --receipt, GET /api/v1/invoices/{id}/receipt; --payee-lock, GET /api/v1/payee-lock/evidence.",
      "The file is the one the workspace's Download gives, members named by user id, under the same name; a receipt, which has no download, is named the same way. A file that is already there is kept unless you pass --force. --out - prints it with every character outside ASCII escaped, so a shell's > cannot change it. Check it offline with `vestiarion evidence verify`.",
      "The evidence reads have a limit of their own, 10 at once per key and then one every 6 seconds: past it, the CLI waits as the API asks.",
    ],
    options: {
      bill: { type: "string", value: "<id>", help: "A bill's evidence: why it was paid, or why it is not paid yet" },
      milestone: { type: "string", value: "<id>", help: "A contractor milestone's evidence" },
      receipt: { type: "string", value: "<bill-id>", help: "A paid bill's receipt" },
      "payee-lock": { type: "boolean", help: "Every payout address change in a period" },
      from: { type: "string", value: "<YYYY-MM-DD>", help: "With --payee-lock: the first day, in UTC (default: the first change)" },
      to: { type: "string", value: "<YYYY-MM-DD>", help: "With --payee-lock: the last day, included, in UTC (default: now)" },
      ...FILE_OPTIONS,
    },
    examples: [
      "vestiarion evidence export --bill 9440f32c-000d-4a63-97f1-4eb6bf78439f",
      "vestiarion evidence export --receipt 9440f32c-000d-4a63-97f1-4eb6bf78439f --out receipt.json",
      "vestiarion evidence export --payee-lock --from 2026-10-01 --to 2026-10-31",
    ],
    async run(ctx) {
      const chosen = SUBJECTS.filter((name) => ctx.values[name] !== undefined && ctx.values[name] !== false);
      if (chosen.length !== 1) throw usageError("Pass exactly one of --bill, --milestone, --receipt and --payee-lock.");
      const subject = chosen[0];
      const from = ctx.string("from");
      const to = ctx.string("to");
      if (subject !== "payee-lock" && (from !== undefined || to !== undefined)) throw usageError("--from and --to go with --payee-lock.");
      for (const [name, day] of [["from", from], ["to", to]] as const) {
        if (day !== undefined && !DAY.test(day)) throw usageError(`--${name} is a day, as YYYY-MM-DD.`);
      }
      const out = plannedOut(ctx);
      const client = ctx.client();
      let document: Document;
      if (subject === "payee-lock") {
        document = (await ctx.call(() => client.payeeLock.evidence({ ...(from ? { from } : {}), ...(to ? { to } : {}) }))) as unknown as Document;
      } else {
        const id = ctx.need(subject);
        const read = (): Promise<unknown> =>
          subject === "bill" ? client.invoices.evidence(id) : subject === "milestone" ? client.milestones.evidence(id) : client.invoices.receipt(id);
        document = (await ctx.call(read)) as unknown as Document;
      }
      return save(ctx, document, out, "evidence verify");
    },
  },
  {
    path: ["evidence", "verify"],
    args: ["<file>"],
    summary: "Check an evidence file offline: a payment's evidence, a receipt, the payee lock's or a close pack",
    description: VERIFY_DESCRIPTION,
    options: KEY_OPTION,
    examples: [
      "vestiarion evidence verify vestiarion-evidence-acme-invoice-9440f32c.json",
      "vestiarion evidence verify receipt.json --public-key ledger-key.pem",
    ],
    offline: true,
    run: (ctx) => verifyRun(ctx),
  },
  {
    path: ["close-pack", "export"],
    args: ["<YYYY-MM>"],
    summary: "Save a month's close pack as a signed file: every payment settled in it, and the entries behind each",
    description: [
      "GET /api/v1/close-packs/{month}. The month is a calendar month in UTC; this month reads so far, and its file is named so.",
      "The file is the one the Monthly close pack page's Download signed JSON gives, members named by user id, under the same name. A month over 4 MB is too large for the API: download it from the workspace. Reading it records nothing in the ledger.",
      "Check it offline with `vestiarion close-pack verify`.",
    ],
    options: FILE_OPTIONS,
    examples: ["vestiarion close-pack export 2026-10", "vestiarion close-pack export 2026-10 --out october.json --json"],
    async run(ctx) {
      const month = ctx.args[0];
      if (!MONTH.test(month)) throw usageError("<YYYY-MM> is a month, such as 2026-10.");
      const out = plannedOut(ctx);
      const client = ctx.client();
      const document = (await ctx.call(() => client.closePacks.get(month))) as unknown as Document;
      return save(ctx, document, out, "close-pack verify");
    },
  },
  {
    path: ["close-pack", "verify"],
    args: ["<file>"],
    summary: "Check a close pack offline: every payment's entries, signed and linked",
    description: [
      ...VERIFY_DESCRIPTION,
      "It takes a close pack only, and prints its totals and the ledger head it was read at. To show the pack leaves no entry out, compare its entries with an audit export checked by `vestiarion ledger verify`.",
    ],
    options: KEY_OPTION,
    examples: ["vestiarion close-pack verify vestiarion-close-pack-acme-2026-10.json --public-key ledger-key.pem"],
    offline: true,
    run: (ctx) => verifyRun(ctx, "vestiarion-close-pack/1"),
  },
];
