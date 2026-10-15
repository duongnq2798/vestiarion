# Publishing to the MCP Registry

[`server.json`](../../server.json), at the repository root, describes the remote MCP server for the official
[MCP Registry](https://registry.modelcontextprotocol.io): its name `io.github.duongnq2798/vestiarion`, its
Streamable HTTP endpoint `https://www.vestiarion.xyz/api/mcp`, and the `Authorization` header it needs, required and
secret, holding no value but `Bearer {api_key}`. `tests/mcp-registry.test.ts` validates it against the registry's
`2025-12-11` schema, kept in `tests/fixtures/mcp-registry/`, and holds its version to the one the server reports.

The registry stores metadata only. Publishing is a person's task, because GitHub sign-in proves the namespace: a
name starting `io.github.duongnq2798/` can only be published by the GitHub account `duongnq2798`.

## Checklist

Run these in PowerShell, one at a time, from a checkout of `main` at the repository root (the folder holding
`server.json`).

- [ ] Install `mcp-publisher` (Windows, from the registry's releases):

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
```

  Move `mcp-publisher.exe` to a folder on `PATH`, or run it as `.\mcp-publisher.exe`. On macOS, `brew install
  mcp-publisher`. Check it with `mcp-publisher --help`.

- [ ] Sign in with GitHub, as `duongnq2798`. It prints a code to enter at `https://github.com/login/device`:

```powershell
mcp-publisher login github
```

- [ ] Publish:

```powershell
mcp-publisher publish
```

  It should end with `Server io.github.duongnq2798/vestiarion version 1.0.0`.

- [ ] Check the entry is listed:

```powershell
curl.exe "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.duongnq2798/vestiarion"
```

- [ ] In a docs PR, add the registry name to the MCP server page (`content/docs/ai-integration/mcp.mdx`), so clients
      that read the registry can be pointed at it.

## Publishing a change

The registry keeps every version and refuses one already published. When the description, the URL, the header or
the tools change:

- [ ] Raise `version` in `server.json` and `serverInfo.version` in `src/app/api/mcp/route.ts` together; the test
      requires them to match.
- [ ] Merge, deploy, then `mcp-publisher publish` again from `main`. Run `mcp-publisher login github` first if it
      answers "Invalid or expired Registry JWT token".

When the registry publishes a newer schema, save it in `tests/fixtures/mcp-registry/`, point `$schema` in
`server.json` and `SCHEMA_FILE` in `tests/mcp-registry.test.ts` at it, and fix what the test then reports.
