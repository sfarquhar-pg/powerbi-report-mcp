import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { ServerContext } from "../context.js";
import { requireProject } from "../context.js";
import { collectReportDefinitionParts } from "../fabricApi.js";
import { fail, ok } from "../helpers/mcpResult.js";

function requireConfirm(confirm: boolean | undefined, action: string) {
  return confirm ? null : fail(
    `${action} changes Power BI Service. Re-run with confirm=true after reviewing the workspace, folder, and report name.`,
    { confirmationRequired: true }
  );
}

function createProjectFiles(reportPath: string, semanticModelId?: string): void {
  if (fs.existsSync(reportPath)) {
    if (!fs.statSync(reportPath).isDirectory()) throw new Error(`Target exists and is not a directory: ${reportPath}`);
    if (fs.readdirSync(reportPath).length > 0) throw new Error(`Refusing to overwrite non-empty directory: ${reportPath}`);
  }

  const definitionPath = path.join(reportPath, "definition");
  const pagesPath = path.join(definitionPath, "pages");
  fs.mkdirSync(pagesPath, { recursive: true });

  const write = (target: string, data: unknown) =>
    fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");

  write(path.join(reportPath, "definition.pbir"), {
    $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
    version: "4.0",
    ...(semanticModelId ? {
      datasetReference: { byConnection: { connectionString: `semanticmodelid=${semanticModelId}` } },
    } : {}),
  });
  write(path.join(definitionPath, "report.json"), {
    $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.2.0/schema.json",
    themeCollection: {
      baseTheme: {
        name: "CY26SU02",
        reportVersionAtImport: { visual: "2.6.0", report: "3.1.0", page: "2.3.0" },
        type: "SharedResources",
      },
    },
    resourcePackages: [{
      name: "SharedResources",
      type: "SharedResources",
      items: [{ name: "CY26SU02", path: "BaseThemes/CY26SU02.json", type: "BaseTheme" }],
    }],
    settings: { useStylableVisualContainerHeader: true, exportDataMode: "AllowSummarized" },
  });
  write(path.join(definitionPath, "version.json"), {
    $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json",
    version: "2.0.0",
  });
  write(path.join(pagesPath, "pages.json"), {
    $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json",
    pageOrder: [],
  });
}

export function registerFabricTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "pbir_create_project",
    "Create a new local PBIR .Report project and connect to it. Refuses to overwrite a non-empty directory. Optionally binds a published semantic model by ID.",
    {
      path: z.string().describe("Absolute target path ending in .Report"),
      semanticModelId: z.string().uuid().optional().describe("Published semantic model UUID for a thin report"),
    },
    { openWorldHint: false },
    async ({ path: targetPath, semanticModelId }) => {
      if (!path.isAbsolute(targetPath)) return fail("Project path must be absolute.");
      if (!targetPath.endsWith(".Report")) return fail("Project path must end with .Report.");
      createProjectFiles(targetPath, semanticModelId);
      const connected = ctx.connectReport(targetPath);
      if (!connected.success) return fail(connected.error ?? "Created project but failed to connect it.");
      return ok({ reportPath: connected.reportPath, semanticModelId, created: true });
    }
  );

  server.tool(
    "pbir_fabric_auth",
    "Manage the private Fabric authentication session. Login opens Microsoft sign-in once, then Azure Identity reuses and refreshes tokens internally. Tokens are never returned. Status never triggers login.",
    {
      operation: z.enum(["status", "login", "logout"]),
      force: z.boolean().optional().default(false).describe("Login only: ignore the current session and authenticate again"),
    },
    { openWorldHint: true },
    async ({ operation, force }) => {
      if (operation === "status") return ok(ctx.fabricAuth.getStatus());
      if (operation === "logout") return ok(ctx.fabricAuth.signOut());
      return ok(await ctx.fabricAuth.login(force));
    }
  );

  server.tool(
    "pbir_fabric_resolve_folder",
    "Resolve a Fabric workspace folder by UUID, display name, or legacy numeric Power BI subfolderId. Requires an existing pbir_fabric_auth session.",
    {
      workspaceId: z.string().uuid(),
      folder: z.string().min(1).describe("Folder UUID, exact display name, or legacy numeric subfolderId"),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ workspaceId, folder }) => ok({ folder: await ctx.fabricApi.resolveFolder(workspaceId, folder) })
  );

  server.tool(
    "pbir_fabric_publish_report",
    "Publish the connected PBIR report to Fabric, or update a specific existing report ID. Requires prior pbir_fabric_auth login and confirm=true. Tokens never leave the MCP process.",
    {
      workspaceId: z.string().uuid(),
      displayName: z.string().min(1).optional().describe("Required for create; defaults to the connected .Report folder name"),
      description: z.string().max(256).optional(),
      folder: z.string().min(1).optional().describe("Folder UUID, exact name, or legacy numeric subfolderId"),
      reportId: z.string().uuid().optional().describe("Existing report UUID to update. Omit to create."),
      confirm: z.boolean().optional().default(false),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ workspaceId, displayName, description, folder, reportId, confirm }) => {
      const guard = requireProject(ctx); if (guard) return guard;
      const confirmation = requireConfirm(confirm, reportId ? "Updating this report" : "Publishing this report");
      if (confirmation) return confirmation;

      const reportPath = ctx.getReportPath()!;
      const resolvedName = displayName ?? path.basename(reportPath).replace(/\.Report$/i, "");
      let folderId: string | undefined;
      let resolvedFolder: Record<string, unknown> | undefined;
      if (folder) {
        const match = await ctx.fabricApi.resolveFolder(workspaceId, folder);
        folderId = match.id;
        resolvedFolder = match as unknown as Record<string, unknown>;
      }

      if (!reportId) {
        const duplicates = (await ctx.fabricApi.listReports(workspaceId)).filter(
          (item) => String(item.displayName).toLowerCase() === resolvedName.toLowerCase()
        );
        if (duplicates.length) {
          return fail(
            `A report named '${resolvedName}' already exists in the workspace. Pass its reportId to update it, or choose another displayName.`,
            { duplicates }
          );
        }
      }

      const parts = collectReportDefinitionParts(reportPath);
      const item = await ctx.fabricApi.publishReport({
        workspaceId,
        displayName: resolvedName,
        description,
        folderId,
        reportId,
        parts,
      });
      const itemId = String(item.id ?? reportId ?? "");
      const appBase = (process.env.PBIR_POWERBI_APP_BASE ?? "https://app.powerbi.com").replace(/\/+$/, "");
      return ok({
        action: reportId ? "updated" : "created",
        item,
        folder: resolvedFolder,
        partCount: parts.length,
        reportUrl: itemId ? `${appBase}/groups/${workspaceId}/reports/${itemId}` : undefined,
      });
    }
  );
}
