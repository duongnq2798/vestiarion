# Publishing to the MCP Registry

[`server.json`](../../server.json), at the repository root, describes the remote MCP server for the official
[MCP Registry](https://registry.modelcontextprotocol.io): its name `io.github.duongnq2798/vestiarion`, its
Streamable HTTP endpoint `https://www.vestiarion.xyz/api/mcp`, and the `Authorization` header it needs, required and
secret, holding no value but `Bearer {api_key}`. `tests/mcp-registry.test.ts` validates it against the registry's
`2025-12-11` schema, kept in `tests/fixtures/mcp-registry/`, and holds its version to `MCP_SERVER_VERSION`
(`src/lib/mcp/version.ts`), the version the server reports.

The registry stores metadata only. Publishing is a person's task, because GitHub sign-in proves the namespace: a
name starting `io.github.duongnq2798/` can only be published by the GitHub account `duongnq2798`.

**Status:** first published on 2026-10-15, as `io.github.duongnq2798/vestiarion` version 1.0.0, active and the latest.
The [MCP server page](https://www.vestiarion.xyz/docs/ai-integration/mcp#in-the-mcp-registry) and the README name
it. Check the entry with:

```text
https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.duongnq2798/vestiarion
```

## First publication (done 2026-10-15)

These are the steps the first publication followed. Run them again only to publish from a new machine; for a change to
`server.json`, see [Publishing a change](#publishing-a-change), which reuses the fetch and publish commands.

The commands are for Windows PowerShell 5.1: one command per block, each run on its own. They install
`mcp-publisher` into `tools\mcp-publisher` in your home folder, outside the repository, and publish the `server.json`
on `main` on GitHub, so no checkout is needed and none can be stale.

- [ ] Make the folder:

```powershell
New-Item -ItemType Directory -Force "$HOME\tools\mcp-publisher"
```

- [ ] Download the Windows build of the latest release (on an Arm PC, replace `amd64` with `arm64`):

```powershell
$ProgressPreference = "SilentlyContinue"; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz" -OutFile "$HOME\tools\mcp-publisher\mcp-publisher.tar.gz"
```

- [ ] Unpack it:

```powershell
tar -xf "$HOME\tools\mcp-publisher\mcp-publisher.tar.gz" -C "$HOME\tools\mcp-publisher" mcp-publisher.exe
```

- [ ] Check it runs. It lists `init`, `login`, `logout` and `publish`:

```powershell
& "$HOME\tools\mcp-publisher\mcp-publisher.exe" --help
```

- [ ] Sign in with GitHub, as `duongnq2798`. It prints a code to enter at `https://github.com/login/device`:

```powershell
& "$HOME\tools\mcp-publisher\mcp-publisher.exe" login github
```

- [ ] Fetch `server.json` from `main`:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/duongnq2798/vestiarion/main/server.json" -OutFile "$HOME\tools\mcp-publisher\server.json"
```

- [ ] Publish it. It should end with `Server io.github.duongnq2798/vestiarion version 1.0.0`:

```powershell
& "$HOME\tools\mcp-publisher\mcp-publisher.exe" publish "$HOME\tools\mcp-publisher\server.json"
```

- [ ] Check the entry is listed:

```powershell
curl.exe "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.duongnq2798/vestiarion"
```

- [ ] In a docs PR, add the registry name to the MCP server page (`content/docs/ai-integration/mcp.mdx`), so clients
      that read the registry can be pointed at it.

## Publishing a change

The registry keeps every version and refuses one already published. Publish again only when a field of `server.json`
itself changes: its description, title, icons, URL or header. A new tool, or a change to one, changes nothing there,
and needs no new entry.

- [ ] Raise `version` in `server.json` and `MCP_SERVER_VERSION` in `src/lib/mcp/version.ts` together; the test
      requires them to match.
- [ ] Merge and deploy, then run the first publication's fetch and publish commands again. If it answers
      "Invalid or expired Registry JWT token", sign in again first.
- [ ] Check the entry: the lookup URL above lists the new version, with `isLatest: true`.

When the registry publishes a newer schema, save it in `tests/fixtures/mcp-registry/`, point `$schema` in
`server.json` and `SCHEMA_FILE` in `tests/mcp-registry.test.ts` at it, and fix what the test then reports.
