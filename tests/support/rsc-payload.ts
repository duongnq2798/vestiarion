import Module, { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import type { ReactNode } from "react";

/**
 * The React Server Components payload a page sends with its HTML, measured with React's own Flight renderer (the
 * production build Next ships), not estimated. A server component is called as Next calls it; a client component is
 * sent as a reference with its props, as Next sends it, once its module is named here. The suite runs without the
 * `react-server` condition, so the renderer is loaded with its `react` and `react-dom` pointed at Next's server builds,
 * and the components it is handed were made with the ordinary `react`: an element is the same object to both.
 *
 * What it leaves out is the same for every measurement: the module rows' chunk lists (one per client module, not per
 * use), and the rest of the page (the layout, the shell).
 *
 * `fromPayload` reads a payload back as the browser does, with React's Flight client, into the tree React then renders:
 * what a client component is given there is what it was sent, not what the server held.
 */

type Resolve = (request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) => string;
type Flight = {
  renderToPipeableStream: (model: ReactNode, manifest: unknown, options?: { onError?: (error: unknown) => void }) => { pipe: (destination: Writable) => void };
};
type Internals = { H: Record<string, unknown> | null };

const nodeRequire = createRequire(import.meta.url);
let flight: Flight | null = null;
let serverInternals: Internals | null = null;

function flightServer(): Flight {
  if (flight) return flight;
  const reactServer = nodeRequire.resolve("next/dist/compiled/react/cjs/react.react-server.production.js");
  serverInternals = (nodeRequire(reactServer) as { __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Internals })
    .__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const reactDomServer = nodeRequire.resolve("next/dist/compiled/react-dom/cjs/react-dom.react-server.production.js");
  const renderer = nodeRequire.resolve("next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.production.js");
  const redirect: Record<string, string> = {
    react: reactServer,
    "next/dist/compiled/react": reactServer,
    "react-dom": reactDomServer,
    "next/dist/compiled/react-dom": reactDomServer,
  };
  const loader = Module as unknown as { _resolveFilename: Resolve };
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (request, parent, ...rest) {
    const from = parent?.filename;
    if ((from === renderer || from === reactDomServer) && redirect[request]) return redirect[request];
    return resolve.call(this, request, parent, ...rest);
  };
  try {
    flight = nodeRequire(renderer) as Flight;
  } finally {
    loader._resolveFilename = resolve;
  }
  return flight;
}

const CLIENT_REFERENCE = Symbol.for("react.client.reference");
const MARKS = ["$$typeof", "$$id", "$$async"] as const;

/** A component from a "use client" module: a function, or an object such as a `forwardRef`. */
export type ClientComponent = object;

/** Every module answers by its own name: the payload names a client module once, however often it is used. */
const MANIFEST = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      const [id, name = ""] = key.split("#");
      return { id, chunks: [], name };
    },
  }
);

/**
 * The payload's bytes for `node`, with `clients` sent as client references: each is marked as one only while it renders
 * and given back unmarked after, so the same component still renders to HTML in the same test.
 */
export async function rscPayload(node: ReactNode, clients: Record<string, ClientComponent>): Promise<string> {
  const { renderToPipeableStream } = flightServer();
  // A server component's hooks (Radix's `Slot` composes refs with `useCallback`) were imported from the ordinary
  // `react`: while the renderer works, they answer from its dispatcher, as they do on the server where both are one.
  const client = (nodeRequire("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Internals })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = client.H;
  client.H = new Proxy({}, { get: (_target, hook: string) => serverInternals?.H?.[hook] });
  const saved = Object.entries(clients).map(([name, component]) => {
    const before = MARKS.map((mark) => Object.getOwnPropertyDescriptor(component, mark));
    Object.defineProperty(component, "$$typeof", { value: CLIENT_REFERENCE, configurable: true });
    Object.defineProperty(component, "$$id", { value: `${name}#${name}`, configurable: true });
    Object.defineProperty(component, "$$async", { value: false, configurable: true });
    return { component, before };
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      let payload = "";
      const sink = new Writable({
        write(chunk, _encoding, done) {
          payload += chunk.toString();
          done();
        },
        final(done) {
          resolve(payload);
          done();
        },
      });
      renderToPipeableStream(node, MANIFEST, { onError: reject }).pipe(sink);
    });
  } finally {
    client.H = dispatcher;
    for (const { component, before } of saved) {
      MARKS.forEach((mark, index) => {
        const descriptor = before[index];
        if (descriptor) Object.defineProperty(component, mark, descriptor);
        else delete (component as Record<string, unknown>)[mark];
      });
    }
  }
}

/**
 * What the payload weighs in the page: Next sends it in inline scripts, each chunk a JSON string with `<`, `>` and `&`
 * written as six-character escapes so no script can close early. Counted in UTF-8 bytes, as the HTML is.
 */
export function inlineScriptBytes(payload: string): number {
  const json = JSON.stringify(payload);
  const escapes = json.match(/[<>&]/g)?.length ?? 0;
  return Buffer.byteLength(json) + escapes * 5;
}

type FlightClient = { createFromNodeStream: (stream: Readable, manifest: unknown) => PromiseLike<ReactNode> };

/**
 * What `render` makes of the tree the browser reads from `payload`, as Next's server render does from the same payload.
 * Each client module the payload names is answered by `modules[name]`: the component itself, or a stand-in a test
 * renders it with instead. A client component's module is asked for as it renders, so `render` runs while they answer.
 */
export async function fromPayload<T>(payload: string, modules: Record<string, ClientComponent>, render: (tree: ReactNode) => T): Promise<T> {
  const client = nodeRequire("next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js") as FlightClient;
  const global = globalThis as { __next_require__?: (id: string) => unknown };
  const saved = global.__next_require__;
  global.__next_require__ = (id: string) => {
    if (!(id in modules)) throw new Error(`the payload names a client module no one answers: ${id}`);
    return { [id]: modules[id] };
  };
  try {
    // As bytes: a long string travels as a text row its length in bytes announces.
    const tree = await client.createFromNodeStream(Readable.from([Buffer.from(payload)]), { moduleMap: null, serverModuleMap: null, moduleLoading: null });
    return render(tree);
  } finally {
    global.__next_require__ = saved;
  }
}
