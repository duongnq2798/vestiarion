/**
 * Renders the Postman collections and environment from the API's OpenAPI document (/api/v1/openapi.json):
 *
 * - "Vestiarion API reference": every operation, in a folder per tag, with its parameters and body, and a saved
 *   example for its success and for each error it documents.
 * - "Vestiarion: Getting Started": the shortest path from a key to a first `200`, then a first write, built from the
 *   same operations with the values a first run needs.
 * - An environment holding `baseUrl` and an empty `apiKey`, marked secret.
 *
 * Nothing is written by hand per endpoint: an operation reaches the reference collection when the document has it,
 * with what the document says about it. Each collection authenticates with `{{apiKey}}` and nothing else, so no file
 * here ever holds a key. tests/postman.test.ts fails while the files in public/postman/ are not what this renders.
 */

/** The parts of the OpenAPI document this reads. */
export interface OpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: { type: string; enum?: readonly string[]; default?: string | number; minimum?: number; maximum?: number };
  example?: string | number;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: OpenApiParameter[];
  requestBody?: { content: { "application/json": { example?: Record<string, unknown> } } };
  responses: Record<string, { description: string; content?: { "application/json"?: { example?: unknown } } }>;
}

export interface OpenApiDoc {
  info: { title: string; description: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

/** The files written to public/postman/, served at https://www.vestiarion.xyz/postman/<file>. */
export const POSTMAN_FILES = {
  gettingStarted: "vestiarion-getting-started.postman_collection.json",
  reference: "vestiarion-api-reference.postman_collection.json",
  environment: "vestiarion.postman_environment.json",
} as const;

export const COLLECTION_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/**
 * Fixed ids: Postman recognizes a collection or environment it already has by its id, and offers to replace it on a
 * second import instead of adding a copy.
 */
const IDS = {
  gettingStarted: "5f0c8a52-3d47-4e0b-9a6c-1b2e7d9f4a10",
  reference: "8c2d4e61-7a95-4b3f-8e10-4f6a9b2c7d35",
  environment: "2b7e9c14-6f38-4d5a-b1e2-9c0d3a8f5e67",
};

/**
 * The message each saved error carries: the API's own words, from the guard or the route that answers with that
 * code. tests/postman.test.ts finds each one in src/, so a message changed there fails until it changes here.
 */
function errorMessage(code: string, op: Operation): string {
  switch (code) {
    case "invalid_request":
      return op.write ? "The body must be JSON." : "cursor is not a cursor this API issued.";
    case "unauthorized":
      return "A valid API key is required.";
    case "forbidden":
      // On a write, the answer a read-only key gets.
      return "This key cannot do that.";
    case "not_found": {
      const id = op.params.find((p) => p.in === "path");
      if (op.id === "get-counterparty" && id) return `Counterparty "${id.example}" was not found.`;
      break;
    }
    case "conflict":
      return "This Idempotency-Key was already used for a different request. Use a new key for a new request.";
    case "rate_limited":
      return "Too many writes from this key. Try again in a minute.";
    case "internal":
      return "The request could not be completed.";
  }
  throw new Error(`${op.id}: no example message for the error "${code}". Add the API's own message for it to scripts/lib/postman.ts.`);
}

/** Headers an error answer carries besides its type. */
const ERROR_HEADERS: Record<string, Array<{ key: string; value: string }>> = {
  rate_limited: [{ key: "Retry-After", value: "60" }],
};

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

interface Operation {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  /** Anything but a `GET` adds records and needs a read-and-write key; every `GET` reads (tests/openapi.test.ts holds both). */
  write: boolean;
  params: OpenApiParameter[];
  body?: Record<string, unknown>;
  status: number;
  example: unknown;
  errors: Array<{ status: number; code: string }>;
}

/** Every operation in the document, in its order. */
function operationsOf(doc: OpenApiDoc): Operation[] {
  const out: Operation[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags.length !== 1) throw new Error(`${op.operationId}: expected one tag, the folder it goes in; got ${op.tags.length}.`);
      for (const param of op.parameters) {
        if (!["query", "path", "header"].includes(param.in)) throw new Error(`${op.operationId}: a parameter in "${param.in}" is not rendered.`);
      }
      const statuses = Object.keys(op.responses).map(Number);
      const success = statuses.filter((status) => status < 300);
      if (success.length !== 1) throw new Error(`${op.operationId}: expected one success response; got ${success.length}.`);
      out.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        tag: op.tags[0],
        summary: op.summary,
        description: op.description,
        write: method !== "get",
        params: op.parameters,
        body: op.requestBody?.content["application/json"].example,
        status: success[0],
        example: op.responses[String(success[0])].content?.["application/json"]?.example,
        errors: statuses
          .filter((status) => status >= 400)
          .sort((a, b) => a - b)
          .map((status) => ({ status, code: op.responses[String(status)].description })),
      });
    }
  }
  return out;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The value a parameter is shown with: its example, else its default, else its first allowed value. */
function valueOf(param: OpenApiParameter): string {
  const value = param.example ?? param.schema.default ?? param.schema.enum?.[0] ?? "";
  return String(value);
}

/** A parameter's description, with the values it allows and its default, as the reference page lists them. */
function describeParam(param: OpenApiParameter): string {
  const parts = [param.description ?? ""];
  if (param.schema.enum) parts.push(`One of: ${param.schema.enum.map((value) => `\`${value}\``).join(", ")}.`);
  return parts.filter(Boolean).join(" ");
}

interface RequestOptions {
  /** Query values to send, by name: each is enabled, and the others stay off. */
  query?: Record<string, string>;
  /** Query values to show switched off, by name, for a reader to tick. */
  queryOff?: Record<string, string>;
  /** Header values to send instead of the parameter's example, by name. */
  headers?: Record<string, string>;
  /** Body fields to send instead of the example's, by name. */
  body?: Record<string, unknown>;
}

function urlOf(op: Operation, options: RequestOptions = {}) {
  const segments = op.path.replace(/^\//, "").split("/").map((segment) => segment.replace(/^\{(.+)\}$/, ":$1"));
  const query = op.params
    .filter((param) => param.in === "query")
    .map((param) => {
      const chosen = options.query?.[param.name];
      return {
        key: param.name,
        value: chosen ?? options.queryOff?.[param.name] ?? valueOf(param),
        description: describeParam(param),
        ...(chosen === undefined && !param.required && { disabled: true }),
      };
    });
  const sent = query.filter((param) => !param.disabled);
  const raw = `{{baseUrl}}/${segments.join("/")}${sent.length > 0 ? `?${sent.map((param) => `${param.key}=${param.value}`).join("&")}` : ""}`;
  const variable = op.params
    .filter((param) => param.in === "path")
    .map((param) => ({ key: param.name, value: valueOf(param), description: describeParam(param) }));
  return {
    raw,
    host: ["{{baseUrl}}"],
    path: segments,
    ...(query.length > 0 && { query }),
    ...(variable.length > 0 && { variable }),
  };
}

function requestOf(op: Operation, options: RequestOptions = {}) {
  const header = op.params
    .filter((param) => param.in === "header")
    .map((param) => ({ key: param.name, value: options.headers?.[param.name] ?? valueOf(param), description: describeParam(param) }));
  const body = op.body && { ...op.body, ...options.body };
  return {
    method: op.method,
    header: body ? [{ key: "Content-Type", value: "application/json" }, ...header] : header,
    ...(body && { body: { mode: "raw", raw: json(body), options: { raw: { language: "json" } } } }),
    url: urlOf(op, options),
  };
}

/** The saved examples: the documented success, then each documented error with the API's own message. */
function responsesOf(op: Operation) {
  const original = requestOf(op);
  const answer = (name: string, code: number, body: unknown, extra: Array<{ key: string; value: string }> = []) => ({
    name,
    originalRequest: original,
    status: STATUS_TEXT[code] ?? String(code),
    code,
    _postman_previewlanguage: "json",
    header: [{ key: "Content-Type", value: "application/json" }, ...extra],
    cookie: [],
    body: json(body),
  });
  return [
    answer(`${op.status} ${STATUS_TEXT[op.status]}`, op.status, op.example),
    ...op.errors.map(({ status, code }) =>
      answer(`${status} ${code}`, status, { error: { code, message: errorMessage(code, op) } }, ERROR_HEADERS[code] ?? [])
    ),
  ];
}

function script(listen: "prerequest" | "test", exec: string[]) {
  return { listen, script: { type: "text/javascript", exec } };
}

/** Each request checks it got the status the operation answers on success, so a collection run shows what failed. */
function statusTest(op: Operation): string[] {
  return [`pm.test("answers ${op.status} ${STATUS_TEXT[op.status]}", function () {`, `  pm.response.to.have.status(${op.status});`, "});"];
}

interface ItemOptions extends RequestOptions {
  name?: string;
  /** Said before the operation's own description. */
  lead?: string;
  prerequest?: string[];
  test?: string[];
}

function itemOf(op: Operation, origin: string, options: ItemOptions = {}) {
  const key = op.write
    ? "**Key:** a read-and-write key. A read-only key gets `403 forbidden`."
    : "**Key:** any workspace API key; a read-only one is enough.";
  const description = [options.lead, op.description, key, `Reference: ${origin}/docs/api/${op.id}`].filter(Boolean).join("\n\n");
  const event = [
    ...(options.prerequest ? [script("prerequest", options.prerequest)] : []),
    script("test", [...statusTest(op), ...(options.test ?? [])]),
  ];
  return {
    name: options.name ?? op.summary,
    event,
    request: { ...requestOf(op, options), description },
    response: responsesOf(op),
  };
}

/** Every request sends `{{apiKey}}` as a bearer token: stop before sending one without it, and say where it goes. */
const KEY_CHECK = [
  'if (!pm.variables.get("apiKey")) {',
  '  throw new Error("apiKey is empty. Choose the Vestiarion environment, top right, and paste a workspace API key as the value of apiKey. That value stays on this machine: never share it.");',
  "}",
];

const AUTH = { type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] };

function collection(id: string, name: string, description: string, origin: string, item: unknown[], variables: Array<{ key: string; value: string; description: string }>) {
  return {
    info: { _postman_id: id, name, description, schema: COLLECTION_SCHEMA },
    auth: AUTH,
    event: [script("prerequest", KEY_CHECK)],
    variable: [
      { key: "baseUrl", value: origin, type: "string", description: "Where the API is. The Vestiarion environment sets the same value." },
      ...variables.map((variable) => ({ ...variable, type: "string" })),
    ],
    item,
  };
}

function operation(ops: Operation[], id: string): Operation {
  const op = ops.find((candidate) => candidate.id === id);
  if (!op) throw new Error(`The Getting Started collection uses the operation "${id}", which the OpenAPI document no longer has.`);
  return op;
}

function reference(doc: OpenApiDoc, ops: Operation[], origin: string) {
  const tags = [...new Set(ops.map((op) => op.tag))];
  const folders = tags.map((tag) => ({ name: tag, item: ops.filter((op) => op.tag === tag).map((op) => itemOf(op, origin)) }));
  const description = [
    `${doc.info.description}`,
    `Every \`/api/v1\` operation, generated from the OpenAPI document at ${origin}/api/v1/openapi.json: one request per operation, in a folder per tag, with its parameters, its body and a saved example of each answer it documents. Optional parameters are listed and switched off; tick one to send it.`,
    "**Authentication.** Each request sends `{{apiKey}}` as `Authorization: Bearer`. Import the Vestiarion environment, choose it, and paste a workspace API key as the value of `apiKey`. That value stays on your machine: never share it, and leave the variable's shared value empty. A read-only key reads everything; the `POST` requests need a read-and-write key. No request can approve, reject or pay: no API call can.",
    `New to the API? Start with the "Vestiarion: Getting Started" collection. Guide: ${origin}/docs/get-started/postman`,
  ].join("\n\n");
  return collection(IDS.reference, "Vestiarion API reference", description, origin, folders, []);
}

/**
 * Steps 4 and 5 add a counterparty at an address the person running them controls, never the reference example's:
 * neither sends until both variables are set.
 */
const VENDOR_CHECK = [
  'if (!pm.variables.get("vendorAddress")) {',
  '  throw new Error("Set vendorAddress to a wallet you control, in this collection\'s Variables. Never confirm an address you do not own.");',
  "}",
  'if (!pm.variables.get("vendorName")) {',
  '  throw new Error("Set vendorName, in this collection\'s Variables, to the name of the vendor at vendorAddress.");',
  "}",
];

function gettingStarted(ops: Operation[], origin: string) {
  const status = operation(ops, "get-status");
  const invoices = operation(ops, "list-invoices");
  const ledger = operation(ops, "list-ledger-entries");
  const addCounterparty = operation(ops, "create-counterparty");
  const addInvoice = operation(ops, "create-invoice");
  const read = {
    name: "1. Read, with a read-only key",
    description: "Steps 1 to 3 read. A read-only key is enough, and the safest key to start with.",
    item: [
      itemOf(status, origin, {
        name: "1. Get the workspace status",
        lead: "The first call to make. A `200` proves the key works, and `provenance.payments` says whether payments on this workspace are live, simulated or unavailable.",
      }),
      itemOf(invoices, origin, {
        name: "2. List invoices",
        query: { limit: "10" },
        lead: "The ten newest invoices. Each carries the agent's verdict and why, in `agentReasoning`. Send `page.nextCursor` back as `cursor` for the next ten.",
      }),
      itemOf(ledger, origin, {
        name: "3. List the agent's decisions, with its reasoning",
        query: { actor: "agent", limit: "200" },
        queryOff: { domain: "ap" },
        lead: "The entries the agent signed into the ledger, with what it decided and, where the decision records one, its reasoning, in `detail`. The ledger answers oldest first, and has no newest-first order: it is a stream to resume from. To reach the latest decisions, send `page.nextCursor` back as `cursor`, ticked under **Params**, until `hasMore` is `false`; keep the last cursor, and the next read starts there. Tick `domain` for payables only. For the latest decisions on bills at once, step 2 is newest first, and each invoice carries the agent's reasoning. The saved example is the reference page's: one entry, of any actor.",
      }),
    ],
  };
  const write = {
    name: "2. Add records, with a read-and-write key",
    description:
      "Steps 4 and 5 add records, and need a key created with **Can also add records** ticked: switch `apiKey` to one. A read-only key gets `403 forbidden`, as the saved examples show.\n\n**First set `vendorName` and `vendorAddress`**, in this collection's **Variables**, to a wallet you control. Step 4 adds a counterparty at that address, and neither step sends until both are set. The address waits for a person in the workspace to confirm it, and the agent pays nothing to it until then. Never confirm an address you do not own: once confirmed, it may be paid, in real USDC on a workspace on Arc mainnet.\n\nAdding is all a key does. The agent decides the invoice as one typed into the console, under every guardrail. The `Idempotency-Key` header makes each step safe to send twice: a repeat within 24 hours gets the first answer back and adds nothing.",
    item: [
      itemOf(addCounterparty, origin, {
        name: "4. Add a counterparty",
        headers: { "Idempotency-Key": "postman-getting-started-counterparty-{{vendorAddress}}" },
        body: { name: "{{vendorName}}", address: "{{vendorAddress}}" },
        lead: "Adds a vendor, screened as one added in the console, at `{{vendorAddress}}`. **Use a wallet you control:** set `vendorName` and `vendorAddress` in the collection's **Variables** before sending. The address waits for a person in the workspace to confirm it; do not confirm an address you do not own. The post-response script keeps the counterparty's `id` as `{{counterpartyId}}` for step 5.",
        prerequest: VENDOR_CHECK,
        test: [
          "if (pm.response.code === 201) {",
          '  pm.collectionVariables.set("counterpartyId", pm.response.json().data.id);',
          "}",
        ],
      }),
      itemOf(addInvoice, origin, {
        name: "5. Add an invoice for it",
        headers: { "Idempotency-Key": "postman-getting-started-invoice-{{counterpartyId}}-{{dueDate}}" },
        body: { counterpartyId: "{{counterpartyId}}", dueDate: "{{dueDate}}" },
        lead: "Adds a payable from the counterparty step 4 added, due 14 days from the day it is sent. Follow the agent's decision on it with step 2, or in the console.",
        prerequest: [
          ...VENDOR_CHECK,
          'if (!pm.collectionVariables.get("counterpartyId")) {',
          '  throw new Error("Send step 4 first: it keeps the new counterparty\'s id for this step.");',
          "}",
          "// Due 14 days from the day this is sent, as YYYY-MM-DD.",
          'pm.collectionVariables.set("dueDate", new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));',
        ],
      }),
    ],
  };
  const description = [
    "From a workspace API key to a first `200`, then a first write.",
    `1. **Set the key.** Import the Vestiarion environment, ${origin}/postman/${POSTMAN_FILES.environment}, choose it at the top right, and paste a workspace API key as the value of \`apiKey\`, which stays on your machine. Never share it. Start with a read-only key.`,
    "2. **Send steps 1 to 3.** They read the workspace's status, its invoices and the agent's decisions with its reasoning.",
    "3. **Steps 4 and 5 add a counterparty and an invoice**, with a read-and-write key. Set `vendorName` and `vendorAddress` in this collection's **Variables** first, to a wallet you control, and never confirm an address you do not own.",
    "Each request has saved examples: its success, and each error it can answer, with the API's own message. No request can approve, reject or pay: no API call can.",
    `Every other operation is in the "Vestiarion API reference" collection. Guide: ${origin}/docs/get-started/postman`,
  ].join("\n\n");
  return collection(IDS.gettingStarted, "Vestiarion: Getting Started", description, origin, [read, write], [
    { key: "vendorName", value: "", description: "Set it before step 4: the name of the vendor step 4 adds, whose wallet is vendorAddress." },
    { key: "vendorAddress", value: "", description: "Set it before step 4: a wallet you control, which step 4 adds as the vendor's address. Never confirm an address you do not own." },
    { key: "counterpartyId", value: "", description: "Set by step 4's post-response script: the counterparty step 5 adds an invoice for." },
    { key: "dueDate", value: "", description: "Set by step 5's pre-request script each time it is sent: 14 days from that day, as YYYY-MM-DD." },
  ]);
}

function environment(origin: string) {
  return {
    id: IDS.environment,
    name: "Vestiarion",
    values: [
      { key: "baseUrl", value: origin, type: "default", enabled: true },
      // Empty, and secret: Postman masks what is typed here. A key is pasted as the variable's value, which stays local;
      // its shared value stays empty, so sharing the environment never shares a key.
      { key: "apiKey", value: "", type: "secret", enabled: true },
    ],
    _postman_variable_scope: "environment",
  };
}

/** Each file in public/postman/, by name, as its text. */
export function renderPostman(doc: OpenApiDoc): Record<string, string> {
  const origin = doc.servers[0]?.url;
  if (!origin) throw new Error("The OpenAPI document names no server.");
  const ops = operationsOf(doc);
  const text = (value: unknown) => `${json(value)}\n`;
  return {
    [POSTMAN_FILES.gettingStarted]: text(gettingStarted(ops, origin)),
    [POSTMAN_FILES.reference]: text(reference(doc, ops, origin)),
    [POSTMAN_FILES.environment]: text(environment(origin)),
  };
}
