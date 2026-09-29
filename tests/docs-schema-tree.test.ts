import { z } from "zod";
import { describe, expect, it } from "vitest";
import { jsonSchema, OPERATIONS } from "@/lib/api/openapi";
import { InvoiceSchema } from "@/lib/api/schemas";
import { schemaTree, type SchemaNode } from "@/lib/docs/schema-tree";

const byName = (nodes: SchemaNode[], name: string) => {
  const node = nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`no field ${name}`);
  return node;
};

function every(nodes: SchemaNode[]): SchemaNode[] {
  return nodes.flatMap((node) => [node, ...every(node.children ?? [])]);
}

describe("schemaTree", () => {
  const tree = schemaTree(z.toJSONSchema(InvoiceSchema) as Record<string, unknown>);

  it("lists an object's fields in order", () => {
    expect(tree.map((node) => node.name)).toEqual(Object.keys(InvoiceSchema.shape));
  });

  it("marks a nullable object nullable and walks into it", () => {
    const counterparty = byName(tree, "counterparty");
    expect(counterparty).toMatchObject({ type: "object", nullable: true });
    expect(counterparty.children?.map((node) => node.name)).toEqual(["id", "name", "riskLevel"]);
  });

  it("reads a nullable scalar and an enum", () => {
    expect(byName(tree, "memo")).toMatchObject({ type: "string", nullable: true });
    expect(byName(tree, "id")).toMatchObject({ type: "string", nullable: false });
    expect(byName(tree, "direction").enum).toEqual(["payable", "receivable"]);
  });

  it("marks every field required, since the interface has none optional", () => {
    expect(every(tree).every((node) => node.required)).toBe(true);
  });

  it("carries descriptions through", () => {
    expect(byName(tree, "agentReasoning").description).toBe("Why the agent ruled as it did, verbatim from the decision.");
    expect(byName(tree, "id").description).toBeUndefined();
  });

  it("walks an array's items, and reads integers, constants and open maps", () => {
    const list = schemaTree(jsonSchema(OPERATIONS.find((op) => op.id === "list-invoices")!.response));
    const data = byName(list, "data");
    expect(data.type).toBe("array of object");
    expect(data.children?.map((node) => node.name)).toContain("counterparty");
    expect(byName(byName(list, "page").children!, "count").type).toBe("integer");
    expect(byName(byName(list, "page").children!, "nextCursor")).toMatchObject({ type: "string", nullable: true });

    const status = schemaTree(jsonSchema(OPERATIONS.find((op) => op.id === "get-status")!.response));
    const fields = byName(status, "data").children!;
    expect(byName(fields, "apiVersion")).toMatchObject({ type: "string", enum: ["v1"] });
    expect(byName(fields, "configuration")).toMatchObject({ type: "object" });
    expect(byName(fields, "configuration").children).toBeUndefined();
  });

  it("marks a field the parent does not require as optional", () => {
    const tree = schemaTree({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] });
    expect(tree.map((node) => [node.name, node.required])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("gives every operation's response a tree with data at the top", () => {
    for (const op of OPERATIONS) {
      const names = schemaTree(jsonSchema(op.response)).map((node) => node.name);
      expect(names, op.id).toEqual(op.collection ? ["data", "page"] : ["data"]);
    }
  });
});
