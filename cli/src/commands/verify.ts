import { readFileSync } from "node:fs";
import { verifyWebhook, WEBHOOK_TOLERANCE_SECONDS, WebhookVerificationError } from "@vestiarion/sdk";
import type { Command } from "../command.js";
import { EXIT, usageError } from "../errors.js";
import { checkLedgerExport } from "../ledger-export.js";

export const VERIFY_COMMANDS: Command[] = [
  {
    path: ["ledger", "verify"],
    args: ["<export.json>"],
    summary: "Check a downloaded audit export offline: every body hash, signature and link",
    description: [
      "Needs no key and no network. It checks each entry with the SDK's verifyLedgerEntry, then the links from genesis and the head, and gives the same answer as the standalone verify-ledger-export.mjs: VALID, BROKEN at an entry, or NOT CHECKED.",
      "Exits 0 when VALID, and 2 when BROKEN or NOT CHECKED.",
      "Without --public-key the file vouches for itself: compare the key id and head hash it prints with the workspace's Audit page, or pass the public key you trust. Across a key rotation, pass every key: repeat --public-key, or put the PEM blocks in one file.",
    ],
    options: {
      "public-key": { type: "string", multiple: true, value: "<key.pem>", help: "Check against this public key instead of the keys the file carries" },
    },
    examples: ["vestiarion ledger verify vestiarion-acme-ledger-1042.json", "vestiarion ledger verify export.json --public-key ledger-key.pem"],
    offline: true,
    async run(ctx) {
      const pins = (ctx.values["public-key"] as string[] | undefined) ?? [];
      const result = await checkLedgerExport(ctx.args[0], pins);
      ctx.print(result, (answer) => `${answer.lines.join("\n")}\n`);
      return result.verdict === "valid" ? EXIT.OK : EXIT.FAILED;
    },
  },
  {
    path: ["webhooks", "verify"],
    summary: "Check a webhook delivery's Vestiarion-Signature against its raw body, offline",
    description: [
      "Needs no key and no network: the SDK's verifyWebhook, with the endpoint's signing secret. Exits 0 when the signature matches, and 2 when it does not.",
      "Pass the body byte for byte as it arrived: a copy that was parsed, reformatted or saved with an added newline differs. A signature more than --tolerance seconds from now is refused, so a delivery saved earlier needs a larger one.",
      "The API has no endpoint that lists webhook endpoints: an owner or an admin manages them on the workspace's Settings page.",
    ],
    options: {
      secret: { type: "string", value: "<secret>", help: "The endpoint's signing secret (default: VESTIARION_WEBHOOK_SECRET)" },
      signature: { type: "string", value: "<header>", help: "The Vestiarion-Signature header, t=<seconds>,v1=<hex>", required: true },
      body: { type: "string", value: "<file>", help: "The raw request body; - reads it from stdin", required: true },
      tolerance: { type: "string", value: "<seconds>", help: `How far the signature's time may be from now (default ${WEBHOOK_TOLERANCE_SECONDS})` },
    },
    examples: ['vestiarion webhooks verify --signature "t=1760000000,v1=5f2b…" --body delivery.json --tolerance 86400'],
    offline: true,
    async run(ctx) {
      const secret = ctx.string("secret") ?? ctx.io.env.VESTIARION_WEBHOOK_SECRET;
      if (!secret) throw usageError("Pass the endpoint's signing secret with --secret, or set VESTIARION_WEBHOOK_SECRET.");
      const signature = ctx.need("signature");
      const bodyPath = ctx.need("body");
      const tolerance = ctx.string("tolerance");
      if (tolerance !== undefined && !/^\d+$/.test(tolerance)) throw usageError("--tolerance is a whole number of seconds.");
      let payload: string;
      try {
        payload = bodyPath === "-" ? await ctx.io.readStdin() : readFileSync(bodyPath, "utf8");
      } catch (error) {
        throw usageError(`The body could not be read (${(error as Error).message}).`);
      }
      try {
        const event = await verifyWebhook({ secret, payload, signature, ...(tolerance !== undefined ? { toleranceSeconds: Number(tolerance) } : {}) });
        const signedAt = new Date(Number(/(?:^|,)t=(\d+)/.exec(signature)?.[1]) * 1000).toISOString();
        return ctx.print({ valid: true, signedAt, event }, () =>
          `VALID: ${event.type} delivery ${event.id}${event.workspace?.slug ? ` for workspace ${event.workspace.slug}` : ""}, signed at ${signedAt}.\n`
        );
      } catch (error) {
        if (!(error instanceof WebhookVerificationError)) throw error;
        ctx.print({ valid: false, reason: error.reason, message: error.message }, () => `INVALID (${error.reason}): ${error.message}\n`);
        return EXIT.FAILED;
      }
    },
  },
];
