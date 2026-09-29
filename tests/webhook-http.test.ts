import http from "node:http";
import type https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookSender, pinnedLookup, WEBHOOK_RESPONSE_READ_LIMIT, WebhookSendError,
} from "@/lib/webhooks/http";
import type { LookupFn } from "@/lib/webhooks/safe-url";

/**
 * The webhook sender (ruling R4): `node:https` with a lookup of its own, so
 * the address checked is the address connected to. A name that resolves
 * again between the check and the connection (DNS rebinding) cannot move the
 * request inside the network.
 *
 * Most of these run the real request code against a local plain-HTTP server:
 * the transport is swapped for `http.request`, and the address rule for one
 * that admits only this loopback server, because every address a test machine
 * can listen on is, rightly, not public. One test keeps the real transport and
 * shows it speaks TLS. The lookup is exercised on its own too.
 */

interface Received {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  remoteAddress?: string;
}

let server: http.Server;
let port: number;
let received: Received[];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeEach(async () => {
  received = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  };
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body, remoteAddress: req.socket.remoteAddress });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const loopback: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
const onlyThisServer = (ip: string) => ip === "127.0.0.1";
const httpTransport = http.request as unknown as typeof https.request;

function localSender(resolve: LookupFn = loopback) {
  return createWebhookSender({ resolve, isAllowed: onlyThisServer, transport: httpTransport });
}

const request = (overrides: Partial<{ url: URL; body: string; timeoutMs: number }> = {}) => ({
  url: new URL(`https://hooks.test:${port}/in?source=vestiarion`),
  headers: { "Content-Type": "application/json", "Vestiarion-Event-Id": "evt-1" },
  body: '{"id":"evt-1","type":"webhook.test"}',
  timeoutMs: 5_000,
  ...overrides,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookSendError);
    return (error as WebhookSendError).reason;
  }
  throw new Error("expected the send to be refused");
}

describe("createWebhookSender", () => {
  it("posts the exact body and headers to the address its own lookup checked", async () => {
    const resolve = vi.fn(loopback);

    const response = await localSender(resolve)(request());

    expect(response).toEqual({ status: 200 });
    expect(resolve).toHaveBeenCalledWith("hooks.test");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/in?source=vestiarion",
      body: '{"id":"evt-1","type":"webhook.test"}',
      remoteAddress: "127.0.0.1",
    });
    expect(received[0].headers).toMatchObject({
      host: `hooks.test:${port}`,
      "content-type": "application/json",
      "vestiarion-event-id": "evt-1",
      "content-length": String(Buffer.byteLength('{"id":"evt-1","type":"webhook.test"}')),
    });
  });

  it("refuses to connect when the name resolves to an address that is not public", async () => {
    const send = createWebhookSender({ resolve: loopback, transport: httpTransport });

    expect(await refusal(send(request()))).toBe("destination is not public");
    expect(received).toEqual([]);
  });

  it.each([
    ["an IPv4 literal", (p: number) => `https://127.0.0.1:${p}/in`],
    ["a bracketed IPv6 literal", (p: number) => `https://[::1]:${p}/in`],
    ["an IPv4-mapped literal", (p: number) => `https://[::ffff:127.0.0.1]:${p}/in`],
  ])("checks %s host itself, without a lookup, and never connects when it is not public", async (_label, url) => {
    const resolve = vi.fn(loopback);
    const send = createWebhookSender({ resolve, transport: httpTransport });

    expect(await refusal(send(request({ url: new URL(url(port)) })))).toBe("destination is not public");
    expect(resolve).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it("connects to an IP literal host that its address rule allows", async () => {
    const resolve = vi.fn(loopback);

    expect(await localSender(resolve)(request({ url: new URL(`https://127.0.0.1:${port}/in`) }))).toEqual({ status: 200 });
    expect(resolve).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
  });

  it("refuses a mixed answer, even when the address it would connect to first is allowed", async () => {
    const send = localSender(async () => [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.7", family: 4 }]);

    expect(await refusal(send(request()))).toBe("destination is not public");
    expect(received).toEqual([]);
  });

  it("reports a name that does not resolve", async () => {
    const send = localSender(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND hooks.test"), { code: "ENOTFOUND" });
    });

    expect(await refusal(send(request()))).toBe("destination could not be resolved");
  });

  it("returns a redirect as its status and never follows it", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` });
      res.end();
    };

    expect(await localSender()(request())).toEqual({ status: 302 });
    expect(received.map((r) => r.url)).toEqual(["/in?source=vestiarion"]);
  });

  it(`stops reading after ${WEBHOOK_RESPONSE_READ_LIMIT} bytes of a response that never ends`, async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write("x".repeat(64 * 1024));
      // Never ended: a sender that read to the end would wait for the timeout.
    };

    const started = Date.now();
    expect(await localSender()(request({ timeoutMs: 5_000 }))).toEqual({ status: 200 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on a receiver that never answers once the timeout passes", async () => {
    handler = () => {
      // Never answers.
    };

    const started = Date.now();
    expect(await refusal(localSender()(request({ timeoutMs: 200 })))).toBe("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a refused connection by its reason only", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const reason = await refusal(localSender()(request()));
    // Listening again (on another port) only so afterEach has a server to close.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    expect(reason).toBe("connection refused");
  });

  it("verifies TLS with the host name, pins the lookup, and keeps no pooled connection", async () => {
    let options: https.RequestOptions | undefined;
    const spy = ((opts: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
      options = opts;
      return http.request(opts as http.RequestOptions, callback);
    }) as unknown as typeof https.request;

    await createWebhookSender({ resolve: loopback, isAllowed: onlyThisServer, transport: spy })(request());

    expect(options).toMatchObject({ method: "POST", hostname: "hooks.test", port: String(port), servername: "hooks.test", agent: false });
    expect(typeof options?.lookup).toBe("function");
    expect(options).not.toHaveProperty("rejectUnauthorized");
  });

  it("speaks TLS by default: a plain-HTTP receiver is refused", async () => {
    const send = createWebhookSender({ resolve: loopback, isAllowed: onlyThisServer });

    expect(await refusal(send(request({ timeoutMs: 2_000 })))).toBe("TLS failed");
    expect(received).toEqual([]);
  });
});

describe("pinnedLookup", () => {
  const call = (lookup: ReturnType<typeof pinnedLookup>, options: { all?: boolean; family?: number }) =>
    new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) => {
      lookup("hooks.test", options as never, (error, address, family) => resolve({ error, address, family }));
    });

  it("hands every checked public address to a caller that asks for all of them", async () => {
    const lookup = pinnedLookup(async () => [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }]);

    expect(await call(lookup, { all: true })).toEqual({
      error: null,
      address: [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }],
      family: undefined,
    });
  });

  it("hands the first checked public address to a caller that asks for one", async () => {
    const lookup = pinnedLookup(async () => [{ address: "1.1.1.1", family: 4 }, { address: "1.0.0.1", family: 4 }]);

    expect(await call(lookup, {})).toEqual({ error: null, address: "1.1.1.1", family: 4 });
  });

  it("keeps to the family the caller asks for", async () => {
    const lookup = pinnedLookup(async () => [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }]);

    expect(await call(lookup, { family: 6 })).toEqual({ error: null, address: "2606:4700::1111", family: 6 });
  });

  it.each([
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["cloud metadata", [{ address: "169.254.169.254", family: 4 }]],
    ["IPv4-mapped private", [{ address: "::ffff:10.0.0.1", family: 6 }]],
    ["mixed", [{ address: "1.1.1.1", family: 4 }, { address: "192.168.1.1", family: 4 }]],
  ])("refuses a %s answer", async (_label, answer) => {
    const result = await call(pinnedLookup(async () => answer), { all: true });

    expect(result.error).toBeInstanceOf(WebhookSendError);
    expect((result.error as WebhookSendError).reason).toBe("destination is not public");
  });

  it("refuses an empty answer and a failed resolution", async () => {
    for (const resolve of [async () => [], async () => Promise.reject(new Error("SERVFAIL"))] as LookupFn[]) {
      const result = await call(pinnedLookup(resolve), { all: true });
      expect((result.error as WebhookSendError).reason).toBe("destination could not be resolved");
    }
  });
});
