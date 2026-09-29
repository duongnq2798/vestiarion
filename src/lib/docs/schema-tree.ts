/**
 * A response's JSON Schema as a tree of fields, for the reference pages and
 * their Markdown views. It reads the shapes `z.toJSONSchema` writes for the
 * v1 schemas: objects with `properties` and `required`, arrays with `items`,
 * `null` as a member of `type` or as an `anyOf` branch, `enum` and `const`,
 * and open maps (`additionalProperties`), which have no fixed fields.
 */

export interface SchemaNode {
  name: string;
  /** `string`, `integer`, `object`, `array of object`, … */
  type: string;
  required: boolean;
  nullable: boolean;
  description?: string;
  enum?: string[];
  children?: SchemaNode[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The schema without its `null` alternative, and whether it had one. */
function withoutNull(schema: Json): { schema: Json; nullable: boolean } {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isObject);
    const rest = branches.filter((branch) => branch.type !== "null");
    if (rest.length === 1 && rest.length < branches.length) {
      // The outer schema's own keywords (a description) win over the branch's.
      const outer = Object.fromEntries(Object.entries(schema).filter(([keyword]) => keyword !== "anyOf"));
      return { schema: { ...rest[0], ...outer }, nullable: true };
    }
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    const types = schema.type.filter((type) => type !== "null");
    return { schema: { ...schema, type: types.length === 1 ? types[0] : types }, nullable: true };
  }
  return { schema, nullable: false };
}

/** The name of a schema's type, reading through arrays: `array of string`. */
function typeName(schema: Json): string {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (typeof schema.type === "string") {
    if (schema.type === "array" && isObject(schema.items)) {
      const item = withoutNull(schema.items);
      return `array of ${typeName(item.schema)}${item.nullable ? " or null" : ""}`;
    }
    return schema.type;
  }
  if ("const" in schema) return schema.const === null ? "null" : typeof schema.const;
  if (isObject(schema.properties)) return "object";
  return "any";
}

/** The allowed values, when the schema names them. */
function allowed(schema: Json): string[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum.filter((value) => value !== null).map(String);
  if ("const" in schema && schema.const !== null) return [String(schema.const)];
  return undefined;
}

/** The fields under a schema: an object's properties, or those of an array's items. */
function fields(schema: Json): SchemaNode[] | undefined {
  if (isObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.entries(schema.properties)
      .filter((entry): entry is [string, Json] => isObject(entry[1]))
      .map(([name, property]) => node(name, property, required.has(name)));
  }
  if (schema.type === "array" && isObject(schema.items)) return fields(withoutNull(schema.items).schema);
  return undefined;
}

function node(name: string, raw: Json, required: boolean): SchemaNode {
  const { schema, nullable } = withoutNull(raw);
  const children = fields(schema);
  const values = allowed(schema);
  return {
    name,
    type: typeName(schema),
    required,
    nullable,
    ...(typeof schema.description === "string" && { description: schema.description }),
    ...(values && { enum: values }),
    ...(children && children.length > 0 && { children }),
  };
}

/** The top-level fields of an object schema (or of an array's items); empty for anything else. */
export function schemaTree(jsonSchema: Record<string, unknown>): SchemaNode[] {
  return fields(withoutNull(jsonSchema).schema) ?? [];
}
