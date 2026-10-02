<!-- doc-version: 1.0 | Last updated: 2026-04-09 -->
# 5-Minute Quickstart

Go from zero to a working Power BI report page in 5 minutes using an AI assistant and the powerbi-report-mcp server.

---

## Prerequisites

- **Node.js 20+** installed
- **Power BI Desktop** (April 2025 or later) with PBIR format enabled:
  File > Options > Preview features > **Store reports using PBIR format**
- **An MCP-compatible client** -- Claude Desktop, Claude Code, Cursor, Cline, GitHub Copilot, or any other MCP client

---

## Step 1: Clone and Build (1 min)

```bash
git clone https://github.com/sfarquhar-pg/powerbi-report-mcp.git
cd powerbi-report-mcp
npm install
npm run build
```

**Alternative -- deploy without building:** The `dist/` folder is committed to the repo, so you can skip the build step. Just clone and install dependencies:

```bash
npm install
node dist/index.js
```

---

## Step 2: Configure Your MCP Client (1 min)

Add the server to your MCP client config. Replace `C:\\path\\to` with the actual path to your cloned repo.

### Claude Desktop

Config file: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "powerbi-report-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\powerbi-report-mcp\\dist\\index.js",
        "C:\\path\\to\\MyReport.Report"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add powerbi-report-mcp -- node "C:\path\to\powerbi-report-mcp\dist\index.js" "C:\path\to\MyReport.Report"
```

### Cursor

Config file: `~/.cursor/mcp.json` or `.cursor/mcp.json` in your project root.

```json
{
  "mcpServers": {
    "powerbi-report-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\powerbi-report-mcp\\dist\\index.js",
        "C:\\path\\to\\MyReport.Report"
      ]
    }
  }
}
```

### Load fewer tools at startup (optional)

By default all 66 report tools load at startup. To load only the 14 default tools and keep token overhead low, add an `env` block (the rest activate on demand through `pbir_load_tools`):

```json
{
  "mcpServers": {
    "powerbi-report-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\powerbi-report-mcp\\dist\\index.js",
        "C:\\path\\to\\MyReport.Report"
      ],
      "env": { "MCP_TOOLS": "minimal" }
    }
  }
}
```

The second argument (the report path) is optional. You can omit it and connect at runtime instead (see Step 3).

**Restart your MCP client** after saving the config.

---

## Step 3: Connect to Your Report (30 sec)

The prompts below assume a report whose semantic model has a `financials` table containing: Country, Segment, Product, Units Sold, Gross Sales, Profit, Date, Month Number, Month Name, Year.

If you set the report path in config (Step 2), you are already connected. Verify by asking:

> List pages

If you did not set a path in config, connect at runtime:

> Connect to C:\path\to\MyReport.Report

You should see a list of existing pages in the report.

---

## Step 4: Create a Page and Add Visuals (2 min)

Ask your AI assistant to build an entire page in one shot:

> Create a page called "Sales Overview" with a dark blue banner titled "Sales Overview" in white bold text, 3 KPI cards for Sum of Gross Sales, Sum of Profit, and Sum of Units Sold, and a clustered bar chart showing Gross Sales by Country.

Behind the scenes, this triggers two tool calls:

1. `pbir_create_page` -- creates a 1280x720 page named "Sales Overview"
2. `pbir_add_visual` (batch mode) -- creates all 5 visuals in a single call:
   - A `shape` rectangle banner (dark blue background, white bold title text)
   - Three `card` visuals bound to `financials[Gross Sales]`, `financials[Profit]`, and `financials[Units Sold]` (all with Sum aggregation)
   - A `clusteredBarChart` with Category = `financials[Country]` and Y = `financials[Gross Sales]` (Sum)

**Expected result:** A page with 5 visuals -- a banner across the top, three KPI cards in a row below it, and a bar chart underneath.

---

## Step 5: Preview in Power BI Desktop (30 sec)

1. Open the `.pbip` file (in the parent folder of the `.Report` folder) in Power BI Desktop
2. If Power BI Desktop is already open with the report, press **Ctrl+Shift+F5** to refresh and pick up the changes
3. Navigate to the "Sales Overview" page

You should see the banner, three KPI cards with aggregated values, and a bar chart breaking down Gross Sales by Country.

---

## What's Next?

- **More prompts:** See [example-prompts.md](example-prompts.md) for a full library of prompts covering charts, formatting, conditional formatting, filters, theming, and multi-page reports.
- **Full tool reference:** See the [README](../README.md) for all 66 tools, formatting options, and supported visual types.
- **Smart tool loading:** All tools are loaded by default. With `MCP_TOOLS=minimal`, 14 default tools load at startup and you can use `pbir_load_tools` mid-session to activate additional tools (filters, themes, conditional formatting, etc.) on demand without restarting.
- **Semantic model queries:** Pair with Microsoft's [powerbi-modeling-mcp](https://github.com/microsoft/powerbi-modeling-mcp) to query your data model, inspect tables and columns, and write DAX -- all from the same AI conversation.
