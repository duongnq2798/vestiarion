/**
 * The version the remote MCP server reports in its handshake (`serverInfo.version`), and the one `server.json` gives
 * the MCP Registry: tests/mcp-registry.test.ts holds the two equal. Raise it when `server.json`'s own fields change,
 * since the registry refuses a version it already has (docs/distribution/mcp-registry.md).
 */
export const MCP_SERVER_VERSION = "1.0.0";
