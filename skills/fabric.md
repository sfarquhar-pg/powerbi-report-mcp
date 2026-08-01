<!-- doc-version: 1.0 | Last updated: 2026-08-01 -->
<!-- summary: Fabric login/session safety, folder resolution, new PBIR project creation, and confirmed report publishing. Read before any Power BI Service action. -->
# Skill: Fabric Service — Authentication, Projects, and Publishing

Local PBIR editing does not require Microsoft authentication. Fabric authentication is only used for Power BI Service operations.

## Tool surface

| Tool | Purpose |
|---|---|
| `pbir_create_project` | Initialize a local `.Report`; optionally bind a published semantic model ID |
| `pbir_fabric_auth` | Check status, explicitly log in, or clear the MCP-held session |
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

## Create a thin report

```json
{
  "path": "/absolute/path/Sales Report.Report",
  "semanticModelId": "00000000-0000-0000-0000-000000000000"
}
```

`pbir_create_project` refuses to overwrite a non-empty directory and connects the new report.

## Resolve and publish

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "folder": "151720"
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
