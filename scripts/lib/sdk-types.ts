/**
 * Renders sdk/src/types.ts from the API's OpenAPI document (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md
 * R3): each payload the API answers with, each write's body and each list's query parameters, as named TypeScript
 * types whose fields keep their descriptions.
 *
 * It reads only the part of JSON Schema the document uses, and throws on any other keyword rather than guess: a type
 * it cannot render is a type the SDK would get wrong.
 */

type Schema = Record<string, unknown>;

export interface OpenApiDoc {
  components: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    Record<string, { operationId: string; parameters?: Array<{ name: string; in: string; required: boolean; description?: string; schema: Schema }> }>
  >;
}

const RENDERED = new Set(["type", "properties", "required", "items", "enum", "const", "anyOf", "additionalProperties", "propertyNames", "description", "minimum", "maximum", "pattern", "default"]);

/** Each named type, where in the document it is read, and the places that must hold the same schema. */
const NAMED: Array<{ name: string; at: string[]; same?: string[][] }> = [
  { name: "Status", at: ["GetStatusResponse", "data"] },
  { name: "LedgerEntry", at: ["ListLedgerEntriesResponse", "data", "[]"] },
  { name: "LedgerVerification", at: ["VerifyLedgerResponse", "data"] },
  { name: "Invoice", at: ["ListInvoicesResponse", "data", "[]"], same: [["CreateInvoiceResponse", "data"]] },
  { name: "Counterparty", at: ["ListCounterpartiesResponse", "data", "[]"], same: [["CreateCounterpartyResponse", "data"]] },
  { name: "CounterpartyDetail", at: ["GetCounterpartyResponse", "data"] },
  { name: "Milestone", at: ["ListMilestonesResponse", "data", "[]"], same: [["CreateMilestoneResponse", "data"]] },
  { name: "PayeeLink", at: ["CreatePayeeLinkResponse", "data"] },
  { name: "Treasury", at: ["GetTreasuryResponse", "data"] },
  { name: "Insights", at: ["GetInsightsResponse", "data"] },
  {
    name: "Page",
    at: ["ListInvoicesResponse", "page"],
    same: [["ListLedgerEntriesResponse", "page"], ["ListCounterpartiesResponse", "page"], ["ListMilestonesResponse", "page"]],
  },
  { name: "CreateInvoiceInput", at: ["CreateInvoiceRequest"] },
  { name: "CreateCounterpartyInput", at: ["CreateCounterpartyRequest"] },
  { name: "CreateMilestoneInput", at: ["CreateMilestoneRequest"] },
  { name: "CreatePayeeLinkInput", at: ["CreatePayeeLinkRequest"] },
];

const HEADER = `// Generated from the API's OpenAPI document (/api/v1/openapi.json) by \`npm run sdk:types\`, with
// scripts/lib/sdk-types.ts. Do not edit it by hand: tests/sdk-types.test.ts fails when it differs from what the
// generator renders now.`;

function at(doc: OpenApiDoc, path: string[]): Schema {
  let schema: Schema | undefined = doc.components.schemas[path[0]];
  for (const step of path.slice(1)) {
    if (!schema) break;
    schema = step === "[]" ? (schema.items as Schema | undefined) : (schema.properties as Record<string, Schema> | undefined)?.[step];
  }
  if (!schema) throw new Error(`${path.join(".")} is not in the OpenAPI document.`);
  return schema;
}

function checkKeywords(schema: Schema, where: string): void {
  for (const key of Object.keys(schema)) {
    if (!RENDERED.has(key)) throw new Error(`${where}: JSON Schema keyword "${key}" is not rendered by the SDK type generator.`);
  }
}

function comment(description: unknown, indent: string): string {
  if (typeof description !== "string" || description.trim() === "") return "";
  const lines = description.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function objectType(schema: Schema, indent: string, where: string): string {
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (!properties) {
    const values = schema.additionalProperties;
    const valueType =
      values && typeof values === "object" && Object.keys(values).length > 0 ? typeOf(values as Schema, indent, `${where}{}`) : "unknown";
    return `Record<string, ${valueType}>`;
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const inner = `${indent}  `;
  const members = Object.entries(properties).map(([name, property]) => {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    return `${comment(property.description, inner)}${inner}${key}${required.has(name) ? "" : "?"}: ${typeOf(property, inner, `${where}.${name}`)};`;
  });
  return `{\n${members.join("\n")}\n${indent}}`;
}

function typeOf(schema: Schema, indent: string, where: string): string {
  checkKeywords(schema, where);
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Schema[]).map((member, i) => typeOf(member, indent, `${where}.anyOf[${i}]`)).join(" | ");
  const types = Array.isArray(schema.type) ? (schema.type as unknown[]) : [schema.type];
  return types
    .map((type) => {
      switch (type) {
        case "string":
          return "string";
        case "number":
        case "integer":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array":
          return `Array<${typeOf(schema.items as Schema, indent, `${where}[]`)}>`;
        case "object":
          return objectType(schema, indent, where);
        default:
          throw new Error(`${where}: type ${JSON.stringify(type)} is not rendered by the SDK type generator.`);
      }
    })
    .join(" | ");
}

function pascal(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function renderSdkTypes(doc: OpenApiDoc): string {
  const parts = [HEADER];

  const code = at(doc, ["ApiError", "error", "code"]);
  checkKeywords(code, "ApiError.error.code");
  if (!Array.isArray(code.enum)) throw new Error("ApiError.error.code has no enum.");
  parts.push(
    `${comment(code.description, "")}export const API_ERROR_CODES = [${code.enum.map((value) => JSON.stringify(value)).join(", ")}] as const;\n\nexport type ApiErrorCode = (typeof API_ERROR_CODES)[number];`
  );

  for (const { name, at: path, same } of NAMED) {
    const schema = at(doc, path);
    for (const other of same ?? []) {
      if (JSON.stringify(at(doc, other)) !== JSON.stringify(schema)) {
        throw new Error(`${name}: ${other.join(".")} differs from ${path.join(".")}; the two cannot share one type.`);
      }
    }
    parts.push(`${comment(schema.description, "")}export interface ${name} ${typeOf(schema, "", name)}`);
  }

  for (const methods of Object.values(doc.paths)) {
    for (const operation of Object.values(methods)) {
      const query = (operation.parameters ?? []).filter((parameter) => parameter.in === "query");
      if (query.length === 0) continue;
      const members = query.map(
        (parameter) =>
          `${comment(parameter.description, "  ")}  ${parameter.name}${parameter.required ? "" : "?"}: ${typeOf(parameter.schema, "  ", `${operation.operationId}.${parameter.name}`)};`
      );
      parts.push(`/** The query parameters of \`${operation.operationId}\`. */\nexport interface ${pascal(operation.operationId)}Params {\n${members.join("\n")}\n}`);
    }
  }

  return `${parts.join("\n\n")}\n`;
}
