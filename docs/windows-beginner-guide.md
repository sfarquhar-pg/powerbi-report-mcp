<!-- doc-version: 1.3 | Last updated: 2026-09-15 -->
# Windows Beginner Guide: Power BI with Claude Code

This guide takes you from a clean Windows computer to using **Claude Code Desktop** to safely work with a Power BI Project. Download the Report MCP only from the current project repository: [sfarquhar-pg/powerbi-report-mcp](https://github.com/sfarquhar-pg/powerbi-report-mcp). You do not need an existing code editor, command-line experience, Azure subscription, or API keys.

You will install two tools:

| Tool | What Claude can do with it |
|---|---|
| **Power BI Modeling MCP** (Microsoft) | Inspect and change tables, columns, measures, DAX, relationships, roles, and other semantic-model metadata. |
| **Power BI Report MCP** (this project) | Inspect and change report pages, visuals, themes, filters, layout, and formatting. |

Both tools run locally on your Windows PC. The Modeling MCP works with Power BI Desktop, Power BI Project files, and Fabric semantic models. The Report MCP works with the folder-based report files in a Power BI Project.

## Before You Start

You need:

- A Windows 10 or Windows 11 PC on which you can install software.
- A Microsoft account. Use your work or school account if you will connect to Fabric.
- A Claude account with a Pro, Max, Team, or Enterprise plan that includes the Claude Code **Code** tab.
- Power BI Desktop.

For local files, you do not need Fabric access, Azure, a service principal, or Power BI REST API credentials.

For a Fabric semantic model, your Microsoft account must already have access to the workspace and model. To make model changes, you need the required write permission. If your organisation has disabled XMLA connectivity, the Modeling MCP cannot connect; ask the workspace owner or Power BI administrator.

## Safety First

AI can change real project files and, for Fabric connections, real semantic models. Start with a small practice report.

1. Work on a copy, not the only copy of a production report.
2. Use Claude Code's **Manual** permission mode while learning.
3. Begin with questions that only inspect the report or model.
4. Ask Claude to show a plan before bulk changes, deletion, publishing, relationship changes, or DAX refactors.
5. Review and approve every tool confirmation only when the proposed action is correct.
6. Do not put passwords, access tokens, claimant data, or other sensitive data into chat.

The Modeling MCP asks for approval before the first semantic-model query and the first model modification. Keep these approvals enabled. Do not use its `--skipconfirmation` setting.

## Part 1: Install the Apps

### 1. Install Power BI Desktop

1. Go to [Power BI Desktop](https://powerbi.microsoft.com/desktop/).
2. Download and install the current Windows version.
3. Open it once. Sign in with your work or school Microsoft account if you will work with Fabric.
4. Select **File > Options and settings > Options > Preview features**.
5. Turn on **Store reports using PBIR format** or **Power BI Report format (PBIR)**. The exact wording can differ by Desktop version.
6. Restart Power BI Desktop if asked.

PBIR is essential. The Report MCP changes the report's folder-based project files; it does not edit a traditional binary `.pbix` report directly.

### 2. Install Claude Desktop and open the Code tab

1. Download [Claude Desktop for Windows](https://claude.ai/api/desktop/win32/x64/setup/latest/redirect). For Windows ARM PCs, use the [ARM64 installer](https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect).
2. Run the installer and open **Claude** from the Windows Start menu.
3. Sign in to your Claude account.
4. Select the **Code** tab at the top of the window.
5. When starting a session, choose **Local** as the environment. Do not use Cloud or WSL for this workflow: Power BI Desktop connections must run on the same Windows PC as Power BI Desktop.
6. In the permission-mode menu beside the prompt, choose **Manual**.

Claude Code Desktop includes a terminal pane. You do not need a separate code editor or a separate Claude CLI installation.

### 3. Install Node.js

Node.js runs the Report MCP and starts Microsoft's Modeling MCP package.

1. Go to [nodejs.org](https://nodejs.org/).
2. Download the **LTS** Windows installer, version 20 or later.
3. Run the installer and keep the default options, including the option to add Node.js to `PATH`.
4. In Claude Code, start a Local session with any folder you trust selected as its project folder.
5. Open the terminal pane from **Views > Terminal**, or press `Ctrl+\``.
6. Type the following commands, one at a time, and press Enter after each:

```powershell
node --version
npm --version
```

Each command should display a version number. If Windows says `node` is not recognised, close Claude Desktop, reopen it, and try again. Restart Windows or reinstall Node.js with the `PATH` option if necessary.

## Part 2: Choose a Test Report

The Report MCP changes a **Power BI Project** report folder (`.Report`), not a binary `.pbix` file. For the first test, this guide pulls a separate local copy of a workspace report you have access to, so it never changes the shared report.

### Recommended first test: pull a workspace report

Use a report link from your own workspace as the first report test case. The link below uses placeholder IDs (`00000000-0000-0000-0000-000000000000`); replace the workspace ID, report ID and folder ID with the values from your own link wherever they appear in this guide:

```text
https://app.powerbi.com/groups/00000000-0000-0000-0000-000000000000/reports/00000000-0000-0000-0000-000000000000?experience=power-bi&subfolderId=<folder-id>
```

A real link identifies:

| Item | Value |
|---|---|
| Workspace ID | `00000000-0000-0000-0000-000000000000` |
| Report ID | `00000000-0000-0000-0000-000000000000` |
| Folder ID | `<folder-id>` |

The folder ID locates the report in Power BI Service. It is not needed to read or pull the report because the report ID already identifies the exact report. Keep the original link handy: it is how you can visually confirm the live report in Power BI Service before and after working on a local copy. The pull creates a new local copy and does not edit, move, publish, or overwrite anything in Fabric.

You will run this test after installing the Report MCP in Part 4.

### Create a practice project

1. In Power BI Desktop, create or open a small, non-sensitive report.
2. Select **File > Save As**.
3. Choose **Power BI Project Files (`.pbip`)** as the file type.
4. Save it somewhere easy to find, for example `C:\PowerBI\Practice\Sales.pbip`.
5. Close Power BI Desktop after saving.

The folder should contain files and folders similar to these:

```text
C:\PowerBI\Practice\
  Sales.pbip
  Sales.Report\
  Sales.SemanticModel\
```

The exact names come from your project name. Keep the `.pbip`, `.Report`, and `.SemanticModel` items together. Do not rename only one of them.

### Convert an existing report

Open the existing `.pbix` in Power BI Desktop, enable PBIR as described above, then use **Save As** to make a new `.pbip` project. Keep the original `.pbix` untouched until you have tested the project version.

## Part 3: Install and Register the MCP Servers

### 1. Make a home for the Report MCP

1. Open [sfarquhar-pg/powerbi-report-mcp](https://github.com/sfarquhar-pg/powerbi-report-mcp) in a browser. This is the repository used by this guide; do not download the older upstream repository instead.
2. Select **Code > Download ZIP**.
3. In Downloads, right-click the ZIP and select **Extract All**.
4. In File Explorer, create `C:\PowerBI-MCP`.
5. Move the extracted folder into `C:\PowerBI-MCP`.
6. Rename the extracted folder to `powerbi-report-mcp` if necessary.

The final path must be:

```text
C:\PowerBI-MCP\powerbi-report-mcp
```

### 2. Build the Report MCP

Start a Local Claude Code session, open its terminal pane, then run:

```powershell
Set-Location "C:\PowerBI-MCP\powerbi-report-mcp"
npm install
npm run build
```

Wait for both commands to complete without an error. The server program will be at:

```text
C:\PowerBI-MCP\powerbi-report-mcp\dist\index.js
```

Do not run `node dist\index.js` by itself to test it. An MCP server communicates with Claude Code through a private channel and will seem to wait silently in a normal terminal.

### 3. Register Microsoft's Modeling MCP

Microsoft publishes its server as an `npx` package. This command tells Claude Code how to download and start it. It does not require Visual Studio Code, .NET, or a downloaded executable.

In the Claude Code terminal, run:

```powershell
claude mcp add --scope user powerbi-modeling-mcp -- npx -y @microsoft/powerbi-modeling-mcp@latest --start
```

`--scope user` makes the server available in all your local Claude Code projects. The `--` before `npx` is important: everything after it is the command that starts the MCP server.

### 4. Register the Report MCP

In the same terminal, run:

```powershell
claude mcp add --scope user powerbi-report-mcp -- node "C:\PowerBI-MCP\powerbi-report-mcp\dist\index.js"
```

Then check that both configurations were saved:

```powershell
claude mcp list
```

You should see `powerbi-modeling-mcp` and `powerbi-report-mcp`. Start a new Local Code session after adding servers, then type `/mcp` in its prompt. Both servers should be present. Use **Reconnect** from that screen if a server is shown as failed.

## Part 4: Pull and Test the Workspace Report

This test downloads a new local `.Report` folder using your existing Microsoft work or school account. It is safe to run before making any report edits. It does not pull model data; it downloads the report definition needed by the Report MCP.

### 1. Start a local session

1. Open the **Code** tab in Claude Desktop.
2. Choose **Local**.
3. Select `C:\PowerBI` as the project folder, or create and select another empty folder you control.
4. Select **Manual** permission mode.
5. Start the session.
6. Type `/mcp` and verify that the two Power BI servers are available.

### 2. Sign in and check access without changing anything

Send this prompt exactly as written:

```text
Use the Power BI Report MCP only. Do not change, publish, overwrite, move,
or delete anything.

This is the original report link. Use it only to verify the exact source:
https://app.powerbi.com/groups/00000000-0000-0000-0000-000000000000/reports/00000000-0000-0000-0000-000000000000?experience=power-bi&subfolderId=<folder-id>

Sign in to Fabric, then audit my read access to this exact report:
workspaceId: 00000000-0000-0000-0000-000000000000
reportId: 00000000-0000-0000-0000-000000000000

Explain the result in plain English and stop before any change.
```

Claude will use `pbir_fabric_auth` to open the Microsoft sign-in page, then `pbir_fabric_audit_access` to check readiness. Sign in with the Microsoft work or school account that has access to the report. Do not approve any request to publish, overwrite, or otherwise modify the report.

If the audit says access is blocked, stop. Ask the workspace owner to grant the minimum report/model access required for the intended work. Do not use another person's account.

### 3. Pull a separate local copy

After the access audit is successful, send:

```text
Use the Power BI Report MCP only. Pull this exact Fabric report into a new,
separate local folder and connect to it:

source link: https://app.powerbi.com/groups/00000000-0000-0000-0000-000000000000/reports/00000000-0000-0000-0000-000000000000?experience=power-bi&subfolderId=<folder-id>
workspaceId: 00000000-0000-0000-0000-000000000000
reportId: 00000000-0000-0000-0000-000000000000
path: C:\PowerBI\WorkspaceReportTest.Report

Do not overwrite any existing folder. Do not publish or change the live
report. Confirm the local path and number of files pulled.
```

The destination must be a new folder name ending in `.Report`. If `C:\PowerBI\WorkspaceReportTest.Report` already exists, choose a new name such as `WorkspaceReportTest-2.Report`; do not ask Claude to overwrite it.

The pull gives the Report MCP a local, editable copy. A pulled `.Report` folder is not a full `.pbip` project by itself, so do not try to open it directly in Power BI Desktop. The original linked report remains the place to view the live report. Later, use a full PBIP project when you need to preview local file changes in Power BI Desktop.

### 4. Verify the local copy without changing it

Send:

```text
Use the Power BI Report MCP only. Do not change anything.
List every page and its visuals in the connected local report. Then use
pbir_validate_wireframe with scope "report" and summarise any layout errors
or warnings in plain English.
```

This verifies that the Report MCP can read the service copy locally. It does not modify Fabric.

### 5. Optional: compare the local copy to the live report

Before any later local editing, use this prompt to prove what differs:

```text
Use the Power BI Report MCP only. Do not change anything. Compare the
connected local report with the live report:
workspaceId: 00000000-0000-0000-0000-000000000000
reportId: 00000000-0000-0000-0000-000000000000

Summarise differences by page, visual, bindings, filters, layout, and
formatting. If there are no differences, say so clearly.
```

Do not publish a test copy back to this workspace without a separate approved change process.

## Part 5: Work with a Local PBIP Project

### 1. Start a session in your Power BI project

1. Open the **Code** tab in Claude Desktop.
2. Choose **Local**.
3. Select the project folder, for example `C:\PowerBI\Practice`.
4. Select **Manual** permission mode.
5. Start the session.
6. Type `/mcp` and verify that the two Power BI servers are available.

### 2. Inspect the model without changing it

In Claude Code, send this prompt. Replace the project name and path with your own.

```text
I am new to these tools. Do not change anything.
Use the Power BI Modeling MCP to open the semantic model from
C:\PowerBI\Practice\Sales.SemanticModel\definition.
List the tables, measures, and relationships in plain English.
```

Approve the Modeling MCP's query confirmation when it appears. Claude should describe the model without editing it.

### 3. Inspect the report without changing it

Send this prompt:

```text
Do not make changes. Use the Power BI Report MCP to connect to
C:\PowerBI\Practice\Sales.Report.
List the report pages and the visuals on each page in plain English.
```

The Report MCP needs the `.Report` **folder**, not the `.pbip` file.

### 4. Make one small, safe report change

Use a practice project. Send this prompt:

```text
Use the Power BI Report MCP only. Connect to
C:\PowerBI\Practice\Sales.Report.
Create a new page called "AI Test" with one card using an exact existing
measure. Do not alter existing pages, measures, data, or filters.
Before changing files, tell me the measure you will use and wait for my approval.
```

Approve only after Claude has identified the correct measure and you agree with its plan.

### 5. Check the result in Power BI Desktop

1. Open `C:\PowerBI\Practice\Sales.pbip` in Power BI Desktop.
2. If it is already open, save any manual changes first, then press `Ctrl+Shift+F5` to refresh it from disk.
3. Open the `AI Test` page and check the card.
4. Save the report only if the result is correct.

Power BI Desktop caches projects that are already open. Report MCP changes do not appear until you refresh or reopen the `.pbip` file.

## Everyday Workflow

When you want Claude to design a report based on the semantic model, use this sequence:

1. Ask the Modeling MCP to inspect the model and identify exact table, column, and measure names.
2. Ask Claude to propose model changes, if needed, but do not apply a large change without review.
3. Approve a specific model change.
4. Ask the Report MCP to create or change report pages using those exact names.
5. Refresh Power BI Desktop and inspect the result visually.
6. Save, commit, or publish only after review.

### Prompts to copy and use

```text
Do not change anything. Use the Modeling MCP to explain this semantic model's tables, relationships, and five most useful measures in business language.
```

```text
Do not change anything. Use the Modeling MCP to check whether this model has a Date table suitable for time intelligence. Explain what you found and propose, but do not apply, improvements.
```

```text
Use the Modeling MCP to identify the exact revenue measure and date field. Then use the Report MCP to propose an executive-summary page with four KPIs, a monthly revenue trend, and a revenue-by-region chart. Show the plan before changing files.
```

```text
Use the Report MCP only. On the page named "Overview", list each visual, its fields, and its filters. Do not change anything.
```

```text
Before deleting any measure, use the Report MCP's model-usage analysis to identify direct and indirect report dependencies. Show safe-to-delete candidates only. Do not delete anything.
```

### Changes that need extra care

Ask for a plan, take a backup, and make a small test first for:

- Deleting, renaming, or bulk-updating objects.
- Relationships, security roles, row-level security, refresh policies, and partitions.
- Large DAX refactors, calculation groups, and Power Query changes.
- Publishing, overwriting, or pulling reports from Fabric.
- Customer, financial, legal, employee, or other sensitive data.

## Connect to a Different Model

### Power BI Desktop

Open the `.pbip` in Power BI Desktop and leave it open. In Claude Code, say:

```text
Connect to "Sales" in Power BI Desktop. Do not change anything. List the available tables.
```

Use the file name shown in the Power BI Desktop title bar.

### PBIP files on disk

Power BI Desktop does not need to be open. Say:

```text
Open the semantic model from C:\PowerBI\Practice\Sales.SemanticModel\definition.
Do not change anything. Describe the model structure.
```

The path must end with the semantic model's `definition` folder, not the `.Report` folder.

### Fabric semantic model

Use your work or school Microsoft account with workspace access. Say:

```text
Connect to semantic model "Sales Model" in Fabric workspace "Finance".
Do not change anything. Tell me whether the connection succeeded and list the model tables.
```

The browser may ask you to sign in. This uses your existing Power BI/Fabric permissions; it does not give Claude extra permissions.

## Troubleshooting

| Problem | What to do |
|---|---|
| `node` or `npm` is not recognised | Close and reopen Claude Desktop, then try the version checks again. Restart Windows or reinstall Node.js LTS with the `PATH` option if needed. |
| The Report MCP does not appear | Start a new Local session, type `/mcp`, and select **Reconnect**. In the terminal, run `claude mcp get powerbi-report-mcp` to check the path. Then run `npm install` and `npm run build` again from the Report MCP folder. |
| The Modeling MCP does not appear | Run `claude mcp get powerbi-modeling-mcp`. If it is missing, repeat the registration command in Part 3 and start a new Local session. |
| Claude does not call a tool | Type `/mcp` and ensure both servers are enabled. In your prompt, explicitly say "use the Power BI Modeling MCP" or "use the Power BI Report MCP". |
| The Report MCP cannot find the report | Give the full `.Report` folder path, such as `C:\PowerBI\Practice\Sales.Report`, not the `.pbip` file path. |
| The Modeling MCP cannot find the local model | Give the full `.SemanticModel\definition` path, not the `.Report` folder. |
| Power BI Desktop does not show the change | Save any manual Desktop edits, then press `Ctrl+Shift+F5` or close and reopen the `.pbip` file. |
| Fabric sign-in uses the wrong account | Start a new Local session and reconnect. If needed, run `claude mcp remove powerbi-modeling-mcp --scope user`, re-add it with the Part 3 command, then start another Local session. |
| Fabric connection is denied | Confirm workspace and semantic-model permissions. Ask the administrator to verify XMLA connectivity is enabled. |
| Claude proposes a risky or unclear change | Reject the confirmation. Ask Claude to name every affected object, show the intended DAX or change set, and propose a smaller reversible step. |

For more detail, type `/mcp` in the Claude Code session and inspect the server status. You can also run `claude mcp list` or `claude mcp get SERVER-NAME` in the Claude Code terminal. Share errors with your support team only after removing secrets and sensitive data.

## Updating

The Modeling MCP starts from `@latest`; a new Claude Code session downloads the current package when needed.

To update the Report MCP:

1. Download and extract the latest ZIP to a new folder.
2. Run `npm install` and `npm run build` in that folder.
3. Replace its configuration using the new absolute path:

```powershell
claude mcp remove powerbi-report-mcp --scope user
claude mcp add --scope user powerbi-report-mcp -- node "C:\PowerBI-MCP\powerbi-report-mcp\dist\index.js"
```

4. Start a new Local Claude Code session.
5. Verify both servers with the read-only prompts before changing a real report.

## Reference Links

- [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Current Power BI Report MCP repository](https://github.com/sfarquhar-pg/powerbi-report-mcp)
- [Microsoft Power BI Modeling MCP](https://github.com/microsoft/powerbi-modeling-mcp)
- [Power BI Modeling MCP troubleshooting](https://github.com/microsoft/powerbi-modeling-mcp/blob/main/TROUBLESHOOTING.md)
- [Power BI Desktop download](https://powerbi.microsoft.com/desktop/)
- [Power BI Report MCP README](../README.md)
