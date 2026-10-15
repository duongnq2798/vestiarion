import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import nextConfig from "../next.config";
import { STATUS_FOR } from "@/lib/api/contract";
import { buildOpenApiDocument, OPERATIONS, operationById } from "@/lib/api/openapi";
import { readSource } from "@/lib/docs/content";
import { COLLECTION_SCHEMA, POSTMAN_FILES, renderPostman, type OpenApiDoc } from "../scripts/lib/postman";

/**
 * The Postman collections and environment the site serves from public/postman/: rendered from the OpenAPI document,
 * valid Postman Collection v2.1, and holding no key.
 */

const ORIGIN = "https://www.vestiarion.xyz";
/** The invented payee-link token of the Create a payee link example (content/docs/examples/create-payee-link.json). */
const EXAMPLE_PAYEE_TOKEN = "vxp_ExampleOnly_NotARealPayeeLinkToken_Examples";
const doc = () => structuredClone(buildOpenApiDocument(ORIGIN)) as unknown as OpenApiDoc;
const committed = (name: string) => readFileSync(path.join("public", "postman", name), "utf8");
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/* eslint-disable @typescript-eslint/no-explicit-any -- a collection is read as the JSON it is */
type Json = any;
const load = (name: string): Json => JSON.parse(committed(name));
const reference = () => load(POSTMAN_FILES.reference);
const gettingStarted = () => load(POSTMAN_FILES.gettingStarted);
const environment = () => load(POSTMAN_FILES.environment);

/** Every request item under `items`, folders opened, in order, with the folder it sits in. */
function requests(items: Json[], folder = ""): Array<{ folder: string; item: Json }> {
  return items.flatMap((item) => (item.item ? requests(item.item, item.name) : [{ folder, item }]));
}

/** `GET /api/v1/counterparties/{id}`, read back from a request's URL. */
const routeOf = (item: Json) => `${item.request.method} /${item.request.url.path.join("/").replace(/:(\w+)/g, "{$1}")}`;

/** Every string anywhere in a JSON value. */
function strings(value: Json): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => [key, ...strings(inner)]);
  return [];
}

/**
 * The published Collection v2.1.0 schema (https://schema.getpostman.com/json/collection/v2.1.0/collection.json), copied
 * unchanged into tests/fixtures/postman/; Postman publishes it under the Apache License 2.0
 * (https://github.com/postmanlabs/schemas). Zod reads a schema that has `properties` but no `type` as any value at all, so a saved
 * response would go unchecked; each such schema is read as the object it describes, which every place using it holds.
 */
function collectionSchema() {
  const schema = JSON.parse(readFileSync("tests/fixtures/postman/collection-v2.1.0.schema.json", "utf8"));
  const typed = (node: Json): void => {
    if (Array.isArray(node)) return node.forEach(typed);
    if (!node || typeof node !== "object") return;
    if (node.properties && !node.type) node.type = "object";
    Object.values(node).forEach(typed);
  };
  typed(schema);
  return z.fromJSONSchema(schema);
}

describe("the Postman files in public/postman/", () => {
  it("are what the generator renders from the current OpenAPI document: run npm run postman:build after an API change", () => {
    const rendered = renderPostman(doc());
    expect(Object.keys(rendered).sort()).toEqual(Object.values(POSTMAN_FILES).sort());
    for (const [name, text] of Object.entries(rendered)) expect(lf(committed(name)), name).toBe(text);
  });

  it("are the only files there", () => {
    expect(readdirSync(path.join("public", "postman")).sort()).toEqual(Object.values(POSTMAN_FILES).sort());
  });

  it("are Postman Collection v2.1 collections, valid against the published schema", () => {
    const schema = collectionSchema();
    for (const collection of [reference(), gettingStarted()]) {
      expect(collection.info.schema).toBe(COLLECTION_SCHEMA);
      const result = schema.safeParse(collection);
      expect(result.success, `${collection.info.name}: ${JSON.stringify(result.error?.issues.slice(0, 3))}`).toBe(true);
    }
    // The check is not vacuous: a saved response's status code as text, or a header without its name, fails it.
    const broken = reference();
    broken.item[0].item[0].response[0].code = "200";
    expect(schema.safeParse(broken).success).toBe(false);
    const headless = reference();
    headless.item[0].item[0].request.header = [{ value: "x" }];
    expect(schema.safeParse(headless).success).toBe(false);
  });

  it("hold no key: each collection authenticates with {{apiKey}} and nothing else, and the environment's apiKey is empty and secret", () => {
    const files = Object.values(POSTMAN_FILES).map((name) => [name, load(name)] as const);
    for (const [name, file] of files) {
      const text = strings(file).join("\n");
      expect(text, name).not.toMatch(/vxk_[a-z2-7]{8}_[A-Za-z0-9_-]+/);
      expect(text, name).not.toMatch(/Bearer\s+(?!\{\{apiKey\}\}|\{api_key\})\S/);
      expect(text, name).not.toMatch(/\b(?:sk_live_|sk-ant-|ghp_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{16})/);
      // A payee link's token opens its page: the only one written anywhere is the reference example's invented one.
      for (const [token] of text.matchAll(/vxp_[A-Za-z0-9_-]{43}/g)) expect(token, name).toBe(EXAMPLE_PAYEE_TOKEN);
    }
    expect(strings(reference()).join("\n")).toContain(EXAMPLE_PAYEE_TOKEN);
    for (const collection of [reference(), gettingStarted()]) {
      expect(collection.auth).toEqual({ type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] });
      for (const { item } of requests(collection.item)) {
        // A request inherits the collection's auth: none sets its own, or an Authorization header.
        expect(item.request.auth, item.name).toBeUndefined();
        expect(item.request.header.map((header: Json) => header.key.toLowerCase()), item.name).not.toContain("authorization");
      }
      for (const variable of collection.variable) expect(variable.key, collection.info.name).not.toMatch(/key|secret|token/i);
    }
    expect(environment()).toEqual({
      id: expect.any(String),
      name: "Vestiarion",
      values: [
        { key: "baseUrl", value: ORIGIN, type: "default", enabled: true },
        { key: "apiKey", value: "", type: "secret", enabled: true },
      ],
      _postman_variable_scope: "environment",
    });
  });

  it("are served from the site as JSON any origin may read, never sniffed as something else", async () => {
    expect(await nextConfig.headers!()).toContainEqual({
      source: "/postman/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    });
  });

  it("are each linked from the Postman guide, by the URL Postman imports from", () => {
    const guide = readSource("get-started/postman");
    for (const name of Object.values(POSTMAN_FILES)) expect(guide, name).toContain(`${ORIGIN}/postman/${name}`);
  });
});

describe("the API reference collection", () => {
  it("has every operation once, in its tag's folder, with the folders in the operations' order", () => {
    const collection = reference();
    expect(collection.info.name).toBe("Vestiarion API reference");
    expect(collection.item.map((folder: Json) => folder.name)).toEqual([...new Set(OPERATIONS.map((op) => op.tag))]);
    const found = requests(collection.item);
    expect(found.map(({ item }) => routeOf(item)).sort()).toEqual(OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort());
    for (const { folder, item } of found) {
      const op = OPERATIONS.find((candidate) => `${candidate.method.toUpperCase()} ${candidate.path}` === routeOf(item))!;
      expect(folder, op.id).toBe(op.tag);
      expect(item.name, op.id).toBe(op.summary);
      expect(item.request.description, op.id).toContain(op.description);
      expect(item.request.description, op.id).toContain(`${ORIGIN}/docs/api/${op.id}`);
      expect(item.request.description.includes("a read-and-write key"), op.id).toBe(op.scope === "write");
    }
  });

  it("sends each operation's parameters and example body, the optional ones switched off", () => {
    for (const { item } of requests(reference().item)) {
      const op = OPERATIONS.find((candidate) => `${candidate.method.toUpperCase()} ${candidate.path}` === routeOf(item))!;
      const query = item.request.url.query ?? [];
      expect(query.map((param: Json) => param.key), op.id).toEqual(op.params.filter((p) => p.in === "query").map((p) => p.name));
      for (const param of query) expect(param.disabled, `${op.id} ${param.key}`).toBe(true);
      expect((item.request.url.variable ?? []).map((v: Json) => v.key), op.id).toEqual(op.params.filter((p) => p.in === "path").map((p) => p.name));
      const headers = item.request.header.map((header: Json) => header.key);
      for (const param of op.params.filter((p) => p.in === "header")) expect(headers, op.id).toContain(param.name);
      if (op.requestExample) {
        expect(item.request.body.options.raw.language, op.id).toBe("json");
        expect(JSON.parse(item.request.body.raw), op.id).toEqual(op.requestExample);
        expect(headers, op.id).toContain("Content-Type");
      } else {
        expect(item.request.body, op.id).toBeUndefined();
      }
    }
  });

  it("saves the documented success, with the reference page's example, and each documented error with its code", () => {
    for (const { item } of requests(reference().item)) {
      const op = OPERATIONS.find((candidate) => `${candidate.method.toUpperCase()} ${candidate.path}` === routeOf(item))!;
      const codes = [op.status, ...op.errors.map((code) => STATUS_FOR[code])].sort((a, b) => a - b);
      expect(item.response.map((answer: Json) => answer.code).sort((a: number, b: number) => a - b), op.id).toEqual(codes);
      const success = item.response.find((answer: Json) => answer.code === op.status);
      expect(JSON.parse(success.body), op.id).toEqual(op.example);
      for (const code of op.errors) {
        const answer = item.response.find((candidate: Json) => candidate.code === STATUS_FOR[code]);
        expect(JSON.parse(answer.body), `${op.id} ${code}`).toEqual({ error: { code, message: expect.any(String) } });
        expect(answer.header, `${op.id} ${code}`).toContainEqual({ key: "Content-Type", value: "application/json" });
      }
      const limited = item.response.find((answer: Json) => answer.code === 429);
      if (limited) expect(limited.header).toContainEqual({ key: "Retry-After", value: "60" });
    }
  });

  it("takes in a new operation without a line written for it", () => {
    const d = doc() as Json;
    d.paths["/api/v1/widgets"] = {
      get: {
        ...structuredClone(d.paths["/api/v1/treasury"].get),
        operationId: "list-widgets",
        summary: "List widgets",
        tags: ["Widgets"],
      },
    };
    const collection = JSON.parse(renderPostman(d)[POSTMAN_FILES.reference]);
    const folder = collection.item.find((candidate: Json) => candidate.name === "Widgets");
    expect(folder.item.map((item: Json) => [item.name, item.request.url.raw])).toEqual([["List widgets", "{{baseUrl}}/api/v1/widgets"]]);
  });

  it("refuses an error it has no message for, rather than invent one", () => {
    const d = doc() as Json;
    d.paths["/api/v1/status"].get.responses["503"] = { description: "unavailable" };
    expect(() => renderPostman(d)).toThrow(/get-status: no example message for the error "unavailable"/);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Where the API's error messages are written: the guard, the shared helpers and the v1 routes. */
const SOURCE_FILES = ["src/lib/api", "src/app/api/v1"].flatMap((dir) => walk(dir));

describe("the saved errors", () => {
  it("quote the API's own messages, as the guard and the routes write them", () => {
    const sources = SOURCE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    // A message built at run time, such as `Counterparty "${id}" was not found.`, matches with any value in its place.
    // Only a template with words of its own counts: one that is all placeholders would match any message.
    const templates = [...sources.matchAll(/`([^`]*\$\{[^`]*)`/g)]
      .map((match) => match[1].split(/\$\{[^}]*\}/))
      .filter((parts) => parts.join("").trim().length >= 12)
      .map((parts) => new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`));
    const messages = new Set(
      [reference(), gettingStarted()].flatMap((collection) =>
        requests(collection.item).flatMap(({ item }) =>
          item.response.filter((answer: Json) => answer.code >= 400).map((answer: Json) => JSON.parse(answer.body).error.message as string)
        )
      )
    );
    expect(messages.size).toBeGreaterThanOrEqual(7);
    for (const message of messages) {
      expect(sources.includes(`"${message}"`) || templates.some((template) => template.test(message)), message).toBe(true);
    }
  });
});

describe("the Getting Started collection", () => {
  const steps = () => requests(gettingStarted().item);
  const step = (n: number) => steps()[n - 1].item;

  it("goes from the workspace's status to its invoices and the agent's decisions, then adds a counterparty and an invoice for it", () => {
    const collection = gettingStarted();
    expect(collection.info.name).toBe("Vestiarion: Getting Started");
    expect(steps().map(({ folder, item }) => [folder, item.name, routeOf(item)])).toEqual([
      ["1. Read, with a read-only key", "1. Get the workspace status", "GET /api/v1/status"],
      ["1. Read, with a read-only key", "2. List invoices", "GET /api/v1/invoices"],
      ["1. Read, with a read-only key", "3. List the agent's decisions, with its reasoning", "GET /api/v1/ledger"],
      ["2. Add records, with a read-and-write key", "4. Add a counterparty", "POST /api/v1/counterparties"],
      ["2. Add records, with a read-and-write key", "5. Add an invoice for it", "POST /api/v1/invoices"],
    ]);
    expect(step(3).request.url.raw).toBe("{{baseUrl}}/api/v1/ledger?limit=200&actor=agent");
    // The ledger has no newest-first order: the step says so, and how to page to the latest decisions.
    expect(step(3).request.description).toContain("The ledger answers oldest first");
    expect(step(3).request.description).toContain("send `page.nextCursor` back as `cursor`");
  });

  it("sends no wallet address of its own: the counterparty's is the one the person running it sets", () => {
    // A literal address here would be a stranger's, which a later confirmation could let the agent pay.
    for (const { item } of steps()) expect(JSON.stringify(item.request), item.name).not.toMatch(/0x[0-9a-fA-F]{40}/);
    const vendor = Object.fromEntries(gettingStarted().variable.map((variable: Json) => [variable.key, variable.value]));
    expect(vendor).toMatchObject({ vendorName: "", vendorAddress: "" });
    expect(JSON.parse(step(4).request.body.raw)).toEqual({
      ...operationById("create-counterparty")!.requestExample,
      name: "{{vendorName}}",
      address: "{{vendorAddress}}",
    });
    // Neither write sends until both are set, and each says why.
    for (const n of [4, 5]) {
      const prerequest = step(n).event.find((event: Json) => event.listen === "prerequest").script.exec.join("\n");
      expect(prerequest, `step ${n}`).toContain('if (!pm.variables.get("vendorAddress")) {');
      expect(prerequest, `step ${n}`).toContain("Set vendorAddress to a wallet you control");
      expect(prerequest, `step ${n}`).toContain('if (!pm.variables.get("vendorName")) {');
    }
    expect(step(4).request.description).toContain("**Use a wallet you control:**");
    expect(step(4).request.description).toContain("do not confirm an address you do not own");
    const folder = gettingStarted().item.find((candidate: Json) => candidate.name === "2. Add records, with a read-and-write key");
    expect(folder.description).toContain("to a wallet you control");
    expect(folder.description).toContain("Never confirm an address you do not own");
  });

  it("starts the reads with a read-only key, and says the writes need a read-and-write one", () => {
    expect(gettingStarted().info.description).toContain("Start with a read-only key.");
    for (const n of [1, 2, 3]) expect(step(n).request.description).toContain("a read-only one is enough");
    for (const n of [4, 5]) expect(step(n).request.description).toContain("A read-only key gets `403 forbidden`.");
  });

  it("adds the invoice for the counterparty step 4 added, due 14 days from the day it is sent, with keys that make each write safe to repeat", () => {
    expect(strings(step(4).event).join("\n")).toContain('pm.collectionVariables.set("counterpartyId", pm.response.json().data.id);');
    const body = JSON.parse(step(5).request.body.raw);
    expect(body).toEqual({ ...operationById("create-invoice")!.requestExample, counterpartyId: "{{counterpartyId}}", dueDate: "{{dueDate}}" });
    // Set on every send, never kept from an earlier day.
    const prerequest: string[] = step(5).event.find((event: Json) => event.listen === "prerequest").script.exec;
    expect(prerequest).toContain('pm.collectionVariables.set("dueDate", new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));');
    expect(prerequest.join("\n")).not.toContain('pm.collectionVariables.get("dueDate")');
    const key = (n: number) => step(n).request.header.find((header: Json) => header.key === "Idempotency-Key").value;
    // The same vendor, or the same invoice on the same day, is added once; another is a new record.
    expect(key(4)).toBe("postman-getting-started-counterparty-{{vendorAddress}}");
    expect(key(5)).toBe("postman-getting-started-invoice-{{counterpartyId}}-{{dueDate}}");
  });

  it("saves the same examples as the reference collection, its success and every error", () => {
    const byRoute = new Map(requests(reference().item).map(({ item }) => [routeOf(item), item.response]));
    for (const { item } of steps()) expect(item.response, item.name).toEqual(byRoute.get(routeOf(item)));
  });
});
