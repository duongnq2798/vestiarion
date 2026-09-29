import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { isPublicAddress, type LookupFn } from "./safe-url";

/**
 * The one way a webhook leaves the platform
 * (docs/superpowers/specs/2026-09-29-webhooks-design.md, W6).
 *
 * Global `fetch` resolves the host again after `assertPublicDestination` has
 * checked it, so a name that answers with a public address for the check and a
 * private one for the connection (DNS rebinding) would reach inside the
 * network. This sender gives `node:https` a lookup of its own instead: it
 * resolves the name, refuses unless every address is public, and hands the
 * socket only those checked addresses. The address checked is the address
 * connected to.
 *
 * - TLS is verified as usual, against the host name (`servername`).
 * - Redirects are never followed: `node:https` does not follow them, and the
 *   status comes back to the caller, which counts a 3xx as a failure.
 * - One timer bounds the whole request, connection and response together.
 * - At most `WEBHOOK_RESPONSE_READ_LIMIT` bytes of the response are read, and
 *   none of it is returned: only the status is.
 * - No connection is pooled (`agent: false`), so every request runs the lookup.
 *
 * Failures reject with a `WebhookSendError` whose `reason` is short and fixed:
 * never the URL, a header, the body or the receiver's answer.
 */

export const WEBHOOK_RESPONSE_READ_LIMIT = 1024;

export interface WebhookRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookResponse {
  status: number;
}

export type WebhookSender = (request: WebhookRequest) => Promise<WebhookResponse>;

export class WebhookSendError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "WebhookSendError";
  }
}

const systemResolve: LookupFn = (host) => dns.promises.lookup(host, { all: true });

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `net.connect` that resolves with `resolve`, refuses unless
 * every answer passes `isAllowed`, and hands back only the checked answers.
 * Node asks for every address (`all: true`) when it tries several in turn, and
 * for one otherwise; both are served.
 */
export function pinnedLookup(resolve: LookupFn, isAllowed: (ip: string) => boolean = isPublicAddress) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    const fail = (reason: string) => callback(new WebhookSendError(reason), "");
    resolve(hostname).then(
      (answers) => {
        if (!Array.isArray(answers) || answers.length === 0) return fail("destination could not be resolved");
        if (!answers.every((answer) => isAllowed(answer?.address))) return fail("destination is not public");
        const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
        const usable = answers
          .filter((answer) => family === 0 || answer.family === family)
          .map(({ address, family: f }) => ({ address, family: f }));
        if (usable.length === 0) return fail("destination could not be resolved");
        if (options?.all) return callback(null, usable);
        callback(null, usable[0].address, usable[0].family);
      },
      () => fail("destination could not be resolved")
    );
  };
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
]);

/** A short, fixed reason for a transport error; its message (which can name the host) is dropped. */
function reasonOf(error: unknown): WebhookSendError {
  if (error instanceof WebhookSendError) return error;
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? "");
  if (code === "ECONNREFUSED") return new WebhookSendError("connection refused");
  if (code === "ECONNRESET" || code === "EPIPE") return new WebhookSendError("connection reset");
  if (code === "ETIMEDOUT") return new WebhookSendError("timed out");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new WebhookSendError("destination could not be resolved");
  if (TLS_CODES.has(code) || code === "EPROTO" || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.includes("CERT")) {
    return new WebhookSendError("TLS failed");
  }
  return new WebhookSendError("connection failed");
}

export interface SenderOptions {
  /** Resolves the host; the system resolver by default. */
  resolve?: LookupFn;
  /** The address rule; `isPublicAddress` by default. Tests admit their own loopback server. */
  isAllowed?: (ip: string) => boolean;
  /** `https.request` by default. Tests pass `http.request` to reach a local server. */
  transport?: typeof https.request;
}

export function createWebhookSender(options: SenderOptions = {}): WebhookSender {
  const lookup = pinnedLookup(options.resolve ?? systemResolve, options.isAllowed ?? isPublicAddress);
  const transport = options.transport ?? https.request;

  return (input) =>
    new Promise<WebhookResponse>((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof https.request> | undefined;
      // One timer for the whole request: connection, answer and body.
      const timer = setTimeout(() => request?.destroy(new WebhookSendError("timed out")), input.timeoutMs);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const hostname = input.url.hostname.replace(/^\[(.*)\]$/, "$1");
      try {
        request = transport(
          {
            method: "POST",
            hostname,
            port: input.url.port || 443,
            path: `${input.url.pathname}${input.url.search}`,
            headers: { ...input.headers, "Content-Length": String(Buffer.byteLength(input.body, "utf8")) },
            lookup: lookup as unknown as https.RequestOptions["lookup"],
            servername: net.isIP(hostname) === 0 ? hostname : undefined,
            agent: false,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            const done = () => settle(() => resolve({ status }));
            let read = 0;
            response.on("data", (chunk: Buffer) => {
              read += chunk.length;
              if (read >= WEBHOOK_RESPONSE_READ_LIMIT) {
                done();
                response.destroy();
              }
            });
            response.on("end", done);
            // The status line has arrived; a body cut short does not change it.
            response.on("error", done);
            response.on("close", done);
          }
        );
      } catch (error) {
        settle(() => reject(reasonOf(error)));
        return;
      }

      request.on("error", (error) => settle(() => reject(reasonOf(error))));
      request.end(input.body, "utf8");
    });
}
