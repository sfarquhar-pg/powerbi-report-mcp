<!-- doc-version: 1.0 | Last updated: 2026-08-01 -->
<!-- summary: Fabric login/session safety, folder resolution, new PBIR project creation, and confirmed report publishing. Read before any Power BI Service action. -->
# Skill: Fabric Service — Authentication, Projects, and Publishing

Local PBIR editing does not require Microsoft authentication. Fabric authentication is only used for Power BI Service operations.

## Tool surface

| Tool | Purpose |
|---|---|
| `pbir_create_project` | Initialize a local `.Report`; optionally bind a published semantic model ID |
| `pbir_fabric_auth` | Check status, explicitly log in, or clear the MCP-held session |
| `pbir_fabric_audit_access` | Audit workspace/report/model readiness and return access directives |
| `pbir_fabric_diff_report` | Compare a local report or JSON snapshot with an exact live report ID |
| `pbir_fabric_pull_report` | Pull live PBIR into a new `.Report` folder or lossless JSON snapshot |
| `pbir_fabric_review_errors` | Check live PBIR components against the bound semantic-model runtime |
| `pbir_fabric_resolve_folder` | Resolve a folder UUID, exact name, or legacy numeric `subfolderId` |
| `pbir_fabric_publish_report` | Create or update a Fabric report from the connected PBIR definition |

## Authentication contract

1. `pbir_fabric_auth({"operation":"status"})` never opens a browser.
2. If unauthenticated, call `pbir_fabric_auth({"operation":"login"})` once.
3. Later Fabric actions reuse the private session and refresh silently when possible.
4. Remote actions never open a browser themselves. If Entra requires MFA, consent, or reauthentication, the action fails and asks for explicit login.
5. Raw access and refresh tokens are never returned, logged, or written by this server.
6. `pbir_fabric_auth({"operation":"logout"})` clears the process session.

The default cache is process-only memory. Restarting the MCP requires login again.

Optional cross-process persistence:

```jsonc
"env": { "PBIR_FABRIC_TOKEN_CACHE": "persistent" }
```

Persistent mode uses Azure Identity's encrypted OS cache: Windows DPAPI, macOS Keychain, or Linux keyring. Plaintext fallback is disabled. If secure storage is unavailable, login fails closed. A mode-600 authentication record may be stored to locate the encrypted cache entry; it contains account identifiers, not bearer tokens.

The single-file Cowork plugin uses process-only caching because native OS keyring modules cannot be bundled. Use the normal npm/local server installation for persistent mode.

## Cloud and environment configuration

Defaults target Microsoft Fabric and Power BI in the public cloud. Deployments with different approved endpoints can configure the MCP process without changing report code:

| Environment variable | Default |
|---|---|
| `AZURE_TENANT_ID` | Account-selected tenant |
| `AZURE_CLIENT_ID` | Azure Identity developer sign-on application |
| `AZURE_AUTHORITY_HOST` | Azure public cloud authority |
| `PBIR_FABRIC_SCOPE` | `https://api.fabric.microsoft.com/.default` |
| `PBIR_POWERBI_SCOPE` | `https://analysis.windows.net/powerbi/api/.default` |
| `PBIR_FABRIC_API_BASE` | `https://api.fabric.microsoft.com/v1` |
| `PBIR_POWERBI_API_BASE` | `https://api.powerbi.com` |
| `PBIR_POWERBI_APP_BASE` | `https://app.powerbi.com` |

These values are trusted administrator/process configuration, not MCP tool inputs. Availability of Fabric APIs still depends on Microsoft support in the selected cloud and tenant policy.

## Create a thin report

```json
{
  "path": "/absolute/path/Sales Report.Report",
  "semanticModelId": "00000000-0000-0000-0000-000000000000",
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "semanticModelWorkspaceId": "00000000-0000-0000-0000-000000000000"
}
```

`pbir_create_project` refuses to overwrite a non-empty directory and connects the new report. When `workspaceId` is supplied, it runs access preflight before creating files. Omit service IDs for a fully offline local project.

## Access audit profiles

`pbir_fabric_audit_access` reports `ready`, `blocked`, or `unknown` for:

- `viewer`: report/model Read.
- `builder`: semantic-model Read + Build/query.
- `reportEditor`: report ReadWrite + model Build.
- `publisher`: destination Contributor-or-higher + model Build; license/tenant policy may still apply.
- `modelEditor`: semantic-model ReadWrite.

Checks distinguish `verified` capability probes, `declared` direct ACLs, and `unknown` Entra-group inheritance. A missing direct ACL is never treated as a denial when group inheritance cannot be expanded.

Default access target:

- View only: report Read + model Read.
- Build/edit a thin report: model Build + report ReadWrite or destination Contributor.
- Publish: destination Contributor (or higher), model Build, and a qualifying license where required.
- Edit the model: model ReadWrite or Contributor (or higher) in its workspace.
- Manage permissions: usually Member/Admin or owner/Reshare rights.

## Review live errors

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "reportId": "00000000-0000-0000-0000-000000000000"
}
```

`pbir_fabric_review_errors` downloads the live PBIR definition, extracts page/visual field references, verifies Build capability, and compiles `TOPN(0)` probes. It returns no semantic-model rows. Missing Build permission and references absent from both TMDL and the probe are errors. A field present in TMDL but rejected by the Execute Queries REST probe is an inconclusive warning: live visual rendering/filtering is stronger evidence and must be checked before declaring the component broken.

## Pull and compare

`pbir_fabric_pull_report` accepts an exact workspace/report ID and either writes the decoded PBIR files to a new `.Report` folder or saves the lossless Fabric definition envelope as JSON. By default it never overwrites existing content.

To replace a local report with the published definition, pass `overwrite:true`. The first call without confirmation returns `confirmationRequired:true`, the exact target, and yes/no choices without downloading or changing files. Save and close Power BI Desktop before confirming: unsaved Desktop work will be discarded, and an open Desktop session may later overwrite the pulled files with stale in-memory state. Re-run with `confirm:true` only after approval. The replacement is staged beside the report; the old report is retained until the new one reconnects successfully and is restored automatically if installation or reconnection fails. Omit `path` to replace the currently connected report.

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "reportId": "00000000-0000-0000-0000-000000000000",
  "overwrite": true,
  "confirm": true
}
```

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "reportId": "00000000-0000-0000-0000-000000000000",
  "path": "/absolute/path/report-live.json",
  "format": "json"
}
```

`pbir_fabric_diff_report` compares the connected report, another `.Report` folder, or a pull JSON snapshot against the current live definition. It reports exact and semantic equality, then groups differences under report-level settings, pages, and page components. Component changes are separated into filters, colours, layout, bindings/data, actions/interactions, formatting, and other metadata. The structured hierarchy and a Markdown rendering are both returned.

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "reportId": "00000000-0000-0000-0000-000000000000",
  "sourcePath": "/absolute/path/Sales.Report",
  "saveLiveJsonPath": "/absolute/path/sales-live.json"
}
```

## Resolve and publish

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "folder": "12345"
}
```

`folder` accepts a Fabric UUID, exact case-insensitive display name, or legacy numeric Power BI `subfolderId`.

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "displayName": "Sales Report",
  "folder": "Test",
  "confirm": true
}
```

- Every create or update requires `confirm:true`.
- Create fails when the workspace already has that display name.
- Updating requires the exact `reportId`; the tool never chooses an overwrite target by name.
- Symlinked report parts are rejected.
