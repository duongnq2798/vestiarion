import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readSource } from "@/lib/docs/content";
import { MCP_SERVER_VERSION } from "@/lib/mcp/version";
import { POST } from "@/app/api/mcp/route";

/**
 * server.json, the remote MCP server's entry for the official MCP Registry (registry.modelcontextprotocol.io), which
 * `mcp-publisher publish` sends. docs/distribution/mcp-registry.md says how it is published.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- server.json and its schema are read as the JSON they are */
type Json = any;
const server = (): Json => JSON.parse(readFileSync("server.json", "utf8"));
const SCHEMA_FILE = "tests/fixtures/mcp-registry/server.schema-2025-12-11.json";

/**
 * The registry's published schema (https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json), copied
 * unchanged into tests/fixtures/mcp-registry/; the MCP project publishes it under the licence of
 * https://github.com/modelcontextprotocol/registry (Apache License 2.0, MIT for older parts). Its one `not`, which refuses `latest` as a
 * package's version, is the only keyword Zod cannot read; server.json lists no packages, so leaving it out loses no
 * check this file is subject to.
 */
function registrySchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8"));
  const nots: string[] = [];
  const find = (node: Json, at: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, inner] of Object.entries(node)) {
      if (key === "not") nots.push(at);
      find(inner, `${at}.${key}`);
    }
  };
  find(schema, "$");
  expect(nots).toEqual(["$.definitions.Package.properties.version"]);
  expect(schema.definitions.Package.properties.version.not).toEqual({ const: "latest" });
  delete schema.definitions.Package.properties.version.not;
  return { id: schema.$id as string, validator: z.fromJSONSchema(schema) };
}

describe("server.json", () => {
  it("names the schema it is checked against: the registry's, kept here", () => {
    expect(server().$schema).toBe(registrySchema().id);
  });

  it("is valid against the MCP Registry's server.json schema", () => {
    const { validator } = registrySchema();
    expect(server().packages).toBeUndefined();
    const result = validator.safeParse(server());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    // The check is not vacuous: a name with no namespace, a description over 100 characters, or a remote without a
    // URL fails it.
    expect(validator.safeParse({ ...server(), name: "vestiarion" }).success).toBe(false);
    expect(validator.safeParse({ ...server(), description: "x".repeat(101) }).success).toBe(false);
    expect(validator.safeParse({ ...server(), remotes: [{ type: "streamable-http" }] }).success).toBe(false);
  });

  it("is named in the GitHub namespace of the repository it points at, as GitHub sign-in to the registry requires", () => {
    const { name, repository } = server();
    expect(repository).toMatchObject({ url: "https://github.com/duongnq2798/vestiarion", source: "github" });
    const owner = new URL(repository.url).pathname.split("/")[1];
    expect(name).toBe(`io.github.${owner}/vestiarion`);
  });

  it("points at the remote MCP server, over Streamable HTTP, the transport it serves", () => {
    expect(server().remotes.map((remote: Json) => [remote.type, remote.url])).toEqual([["streamable-http", "https://www.vestiarion.xyz/api/mcp"]]);
    // The route at /api/mcp answers a POST, where a Streamable HTTP client sends every message.
    expect(typeof POST).toBe("function");
  });

  it("asks for a workspace API key as a required, secret Authorization header, and holds none", () => {
    expect(server().remotes[0].headers).toEqual([
      {
        name: "Authorization",
        description: expect.stringContaining("Use a read-only key unless the agent must add records"),
        isRequired: true,
        isSecret: true,
        value: "Bearer {api_key}",
        variables: { api_key: expect.objectContaining({ isRequired: true, isSecret: true }) },
      },
    ]);
    const text = readFileSync("server.json", "utf8");
    expect(text).not.toMatch(/vxk_[a-z2-7]{8}_[A-Za-z0-9_-]+/);
    expect(text).not.toMatch(/"default"/);
  });

  it("states the version the server reports in its MCP handshake", () => {
    expect(server().version).toBe(MCP_SERVER_VERSION);
  });

  it("has a description the MCP docs page agrees with: a read-only key by default, a read-and-write key to add records", () => {
    const page = readSource("ai-integration/mcp");
    expect(page).toContain("Start with a read-only key");
    expect(page).toContain("The write tools need a read-and-write key");
  });
});
