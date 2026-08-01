# MCP Client Configs

Ready-to-use config files for each AI client. Copy the one you need, update the path, and you're connected.

> Both servers are included: **powerbi-report-mcp** (this repo) and **powerbi-modeling-mcp** (semantic model). Remove the modeling entry if you don't need it.

## Setup

### PogustGoodhead WSL workspace

Use [`pogustgoodhead-wsl.json`](pogustgoodhead-wsl.json) when the MCP client and
Node.js run inside WSL. It points the report server at the current Linux
workspace and starts Microsoft's modeling server through `npx`.

The checked-in WSL config sets `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`
because this Ubuntu installation currently has no ICU runtime. For full locale
support, install the distribution's `libicu` package and remove that environment
override.

```bash
cd /home/samuelfarquharlinux/projects/PogustGoodhead/powerbi-report-mcp
npm ci
npm run build
```

For reports kept on the Windows drive, pass their WSL path to
`pbir_set_report`, for example
`/mnt/c/PowerBI/PGSurvey/PGSurvey.Report`. Power BI Desktop can continue opening
the corresponding `C:\PowerBI\PGSurvey\PGSurvey.pbip`; keeping active projects
on `C:` avoids Desktop issues with `\\wsl.localhost` paths.

The modeling server supports three targets:

- Fabric semantic model: run the WSL config and use interactive Entra auth.
- PBIP/TMDL files: run the WSL config and provide the WSL path.
- Power BI Desktop on Windows: if WSL cannot discover Desktop's local Analysis
  Services process, run the MCP client/modeling server on Windows instead. The
  report server may still run through WSL with
  `wsl.exe node /home/samuelfarquharlinux/projects/PogustGoodhead/powerbi-report-mcp/dist/index.js`.

For Fabric automation, add `--authmode=serviceprincipal` and provide
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and either `AZURE_CLIENT_SECRET` or the
certificate variables in the MCP client's environment. Do not commit those
values. Interactive authentication is the default; set `AZURE_TENANT_ID` when
the account must be constrained to a specific tenant.

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

## Optional: Load all tools at startup

Add an `env` block to load all 54 tools instead of the default 11:

```json
"powerbi-report-mcp": {
  "command": "node",
  "args": ["C:\\path\\to\\powerbi-report-mcp\\dist\\index.js"],
  "env": { "MCP_TOOLS": "all" }
}
```
