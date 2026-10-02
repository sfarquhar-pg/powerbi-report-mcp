# MCP Client Configs

Ready-to-use config files for each AI client. Copy the one you need, update the path, and you're connected.

> Both servers are included: **powerbi-report-mcp** (this repo) and **powerbi-modeling-mcp** (semantic model). Remove the modeling entry if you don't need it.

## Setup

### WSL

Use [`wsl.json`](wsl.json) when the MCP client and Node.js run inside WSL. Update
the placeholder path to your local clone. It starts Microsoft's modeling server
through `npx`.

Install your distribution's ICU runtime (`libicu`) when the modeling server
requires locale support. As a last resort for invariant-only environments, add
`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` locally; it is not enabled in the
public example because it disables normal locale behavior.

```bash
cd /home/your-user/path/to/powerbi-report-mcp
npm ci
npm run build
```

For reports kept on the Windows drive, pass their WSL path to
`pbir_set_report`, for example
`/mnt/c/PowerBI/Sales/Sales.Report`. Power BI Desktop can continue opening
the corresponding `C:\PowerBI\Sales\Sales.pbip`; keeping active projects
on `C:` avoids Desktop issues with `\\wsl.localhost` paths.

The modeling server supports three targets:

- Fabric semantic model: run the WSL config and use interactive Entra auth.
- PBIP/TMDL files: run the WSL config and provide the WSL path.
- Power BI Desktop on Windows: if WSL cannot discover Desktop's local Analysis
  Services process, run the MCP client/modeling server on Windows instead. The
  report server may still run through WSL with
  `wsl.exe node /home/your-user/path/to/powerbi-report-mcp/dist/index.js`.

For Fabric automation, add `--authmode=serviceprincipal` and provide
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and either `AZURE_CLIENT_SECRET` or the
certificate variables in the MCP client's environment. Do not commit those
values. Interactive authentication is the default; set `AZURE_TENANT_ID` when
the account must be constrained to a specific tenant.

The report server's optional Fabric publishing tools use explicit login and a
process-only token cache by default. Set `PBIR_FABRIC_TOKEN_CACHE=persistent`
to reuse authentication across server restarts. This requires working OS secure
storage and never falls back to plaintext token storage.

### Windows

**1. Update the paths** in your chosen config file:
- Replace `C:\\path\\to\\powerbi-report-mcp` with the actual report-mcp install location
- Replace `C:\\path\\to\\powerbi-modeling-mcp` with the actual modeling-mcp install location (the VS Code extension installs to `%USERPROFILE%\.vscode\extensions\analysis-services.powerbi-modeling-mcp-*\`)

**2. Copy to the right location:**

| File | Client | Copy to |
|------|--------|---------|
| `claude-desktop.json` | Claude Desktop | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| `cursor.json` | Cursor | `~/.cursor/mcp.json` |
| `vscode-copilot.json` | GitHub Copilot | `.vscode/mcp.json` (in your project root) |
| `windsurf.json` | Windsurf | `~/.windsurf/mcp.json` |
| `continue-dev.json` | Continue.dev | `~/.continue/config.json` (merge into `mcpServers`) |
| `cline.json` | Cline | VS Code Settings → Cline MCP Servers |

**3. Claude Code** (CLI — no config file needed):

```bash
claude mcp add powerbi-report-mcp node C:\path\to\powerbi-report-mcp\dist\index.js
claude mcp add powerbi-modeling-mcp C:\path\to\powerbi-modeling-mcp\server\powerbi-modeling-mcp.exe
```

## Optional: Pre-connect to a report

Add the report path as a second argument to skip the `pbir_set_report` step:

```json
"args": ["C:\\path\\to\\powerbi-report-mcp\\dist\\index.js", "C:\\path\\to\\MyReport.Report"]
```

## Optional: Load only the default tools

All 66 report tools load at startup by default. Add an `env` block to load only the 14 default tools instead (the rest activate on demand through `pbir_load_tools`):

```json
"powerbi-report-mcp": {
  "command": "node",
  "args": ["C:\\path\\to\\powerbi-report-mcp\\dist\\index.js"],
  "env": { "MCP_TOOLS": "minimal" }
}
```

## Optional: Environment variables

| Variable | Effect |
|----------|--------|
| `PBIR_REPORT_PATH` | Report to connect at startup when no path argument is passed (the argument wins if both are set) |
| `MCP_BINDING_VALIDATION` | Field-binding validation mode: `strict` (default), `warn` or `off` |
| `MCP_FONT_DEFAULTS` | Set to `off` to skip implicit font injection so the report theme drives typography |
| `MCP_TOOLS` | `minimal` loads only the 14 default tools; unset loads all tools |
| `PBIR_FABRIC_TOKEN_CACHE` | `persistent` reuses Fabric authentication across restarts (see above) |
