import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { ServerContext } from "../context.js";
import { requireProject } from "../context.js";
import { collectReportDefinitionParts } from "../fabricApi.js";
import { auditFabricPermissions, reviewLiveReportErrors } from "../fabricAudit.js";
import { fail, ok } from "../helpers/mcpResult.js";
import {
  finalizeMaterializedDefinition,
  getDefinitionParts,
  materializeDefinitionParts,
  readDefinitionParts,
  recoverInterruptedReportReplacement,
  rollbackMaterializedDefinition,
  writeDefinitionSnapshot,
} from "../reportDefinition.js";
import { compareReportDefinitions } from "../reportDiff.js";
import { invalidateAll } from "../helpers/readCache.js";
import { invalidateCache } from "../model-usage.js";
import { applyStyleProfile, extractStyleProfile, parsePowerBiReportUrl } from "../styleMirror.js";

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
      workspaceId: z.string().uuid().optional().describe("Optional destination workspace for access preflight"),
      semanticModelWorkspaceId: z.string().uuid().optional().describe("Optional model workspace; defaults to workspaceId"),
      runPreflight: z.boolean().optional().default(true).describe("When workspaceId is supplied, audit access before creating files"),
    },
    { openWorldHint: false },
    async ({ path: targetPath, semanticModelId, workspaceId, semanticModelWorkspaceId, runPreflight }) => {
      if (!path.isAbsolute(targetPath)) return fail("Project path must be absolute.");
      if (!targetPath.endsWith(".Report")) return fail("Project path must end with .Report.");
      let accessAudit: Awaited<ReturnType<typeof auditFabricPermissions>> | undefined;
      if (runPreflight && workspaceId) {
        accessAudit = await auditFabricPermissions(ctx.fabricApi, {
          account: String(ctx.fabricAuth.getStatus().account ?? "") || undefined,
          workspaceId,
          semanticModelId,
          semanticModelWorkspaceId,
        });
        if (accessAudit.profiles.builder === "blocked" || accessAudit.profiles.publisher === "blocked") {
          return fail("Fabric access preflight found verified blockers. No local project files were created.", { accessAudit });
        }
      }
      createProjectFiles(targetPath, semanticModelId);
      const connected = ctx.connectReport(targetPath);
      if (!connected.success) return fail(connected.error ?? "Created project but failed to connect it.");
      return ok({ reportPath: connected.reportPath, semanticModelId, created: true, accessAudit });
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
    "pbir_fabric_audit_access",
    "Audit effective readiness for workspace, report, and semantic-model actions. Combines direct RBAC evidence with zero-sensitive-data capability probes and returns access directives. Requires an existing Fabric auth session.",
    {
      workspaceId: z.string().uuid(),
      reportId: z.string().uuid().optional(),
      semanticModelId: z.string().uuid().optional().describe("Optional when reportId resolves its underlying model"),
      semanticModelWorkspaceId: z.string().uuid().optional().describe("Optional when the model is in another workspace; report metadata is used when available"),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ workspaceId, reportId, semanticModelId, semanticModelWorkspaceId }) => ok({
      audit: await auditFabricPermissions(ctx.fabricApi, {
        account: String(ctx.fabricAuth.getStatus().account ?? "") || undefined,
        workspaceId,
        reportId,
        semanticModelId,
        semanticModelWorkspaceId,
      }),
    })
  );

  server.tool(
    "pbir_fabric_review_errors",
    "Review a live Fabric report for broken table/field references. Reads PBIR, verifies semantic-model Build capability, and compiles zero-row field probes without returning model data.",
    {
      workspaceId: z.string().uuid(),
      reportId: z.string().uuid(),
      semanticModelId: z.string().uuid().optional().describe("Optional override; defaults to the report's datasetId"),
      semanticModelWorkspaceId: z.string().uuid().optional().describe("Optional override; defaults to the report's datasetWorkspaceId"),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ workspaceId, reportId, semanticModelId, semanticModelWorkspaceId }) => ok({
      review: await reviewLiveReportErrors(ctx.fabricApi, { workspaceId, reportId, semanticModelId, semanticModelWorkspaceId }),
    })
  );

  server.tool(
    "pbir_fabric_pull_report",
    "Pull an exact Fabric PBIR report definition into a local .Report folder or lossless JSON snapshot. Existing reports are replaced only with overwrite=true and confirm=true, using transactional rollback.",
    {
      workspaceId: z.string().uuid(),
      reportId: z.string().uuid(),
      path: z.string().optional().describe("Absolute destination ending in .Report or .json. May be omitted only when overwriting the connected report."),
      format: z.enum(["pbir", "json"]).optional().default("pbir"),
      connect: z.boolean().optional().describe("Connect the pulled .Report; defaults to true for PBIR and false for JSON"),
      overwrite: z.boolean().optional().default(false).describe("Replace the existing PBIR report at path, or the connected report when path is omitted"),
      confirm: z.boolean().optional().default(false).describe("Required with overwrite=true after reviewing the destructive confirmation response"),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ workspaceId, reportId, path: requestedPath, format, connect, overwrite, confirm }) => {
      const targetPath = requestedPath ?? (overwrite && format === "pbir" ? ctx.getReportPath() : null);
      if (!targetPath) return fail("Pull destination path is required unless overwrite=true is replacing the connected PBIR report.");
      if (!path.isAbsolute(targetPath)) return fail("Pull destination must be absolute.");
      if (format === "pbir" && !targetPath.endsWith(".Report")) return fail("PBIR pull destination must end with .Report.");
      if (format === "json" && !targetPath.toLowerCase().endsWith(".json")) return fail("JSON pull destination must end with .json.");
      if (format === "json" && connect) return fail("A JSON snapshot cannot be connected as a report. Use format='pbir' or omit connect.");
      if (format === "json" && overwrite) return fail("Overwrite mode is supported only for PBIR .Report folders.");
      if (overwrite && !confirm) {
        return fail(
          `This will overwrite the current local report at '${targetPath}' with the published Power BI report ` +
          `${workspaceId}/${reportId}. Unsaved changes in this folder will be lost. Save and close Power BI Desktop first, ` +
          `or Desktop may overwrite the pulled files with stale in-memory state. Re-run with confirm=true to continue, ` +
          `or leave confirm=false to cancel.`,
          {
            confirmationRequired: true,
            choices: ["yes", "no"],
            action: "overwriteLocalReport",
            targetPath,
            workspaceId,
            reportId,
          }
        );
      }
      if (!overwrite && fs.existsSync(targetPath) &&
          (!fs.statSync(targetPath).isDirectory() || fs.readdirSync(targetPath).length > 0)) {
        return fail(
          `Refusing to overwrite existing content: ${targetPath}. To replace an existing PBIR report, set overwrite=true and review the confirmation prompt.`,
          { overwriteRequired: true, targetPath }
        );
      }

      if (overwrite) recoverInterruptedReportReplacement(targetPath);

      const definition = await ctx.fabricApi.getReportDefinition(workspaceId, reportId);
      const parts = getDefinitionParts(definition);
      if (!parts.length) return fail("Fabric returned no PBIR definition parts for this report.");
      const itemProbe = await ctx.fabricApi.probe(() => ctx.fabricApi.getItem(workspaceId, reportId));
      const appBase = (process.env.PBIR_POWERBI_APP_BASE ?? "https://app.powerbi.com").replace(/\/+$/, "");
      const source = { workspaceId, reportId };

      if (format === "json") {
        const snapshot = writeDefinitionSnapshot(definition, targetPath, source);
        return ok({
          action: "pulled",
          format,
          ...source,
          reportUrl: `${appBase}/groups/${workspaceId}/reports/${reportId}`,
          item: itemProbe.value,
          ...snapshot,
        });
      }

      const connectedPath = ctx.getReportPath();
      const connectedIdentity = connectedPath && fs.existsSync(connectedPath)
        ? fs.realpathSync(connectedPath)
        : undefined;
      const pulled = materializeDefinitionParts(parts, targetPath, { overwrite });
      const targetIdentity = fs.realpathSync(targetPath);
      const replacingConnectedReport = overwrite && ctx.getReportPath() !== null &&
        connectedIdentity === targetIdentity;
      const shouldConnect = replacingConnectedReport || (connect ?? true);
      if (shouldConnect) {
        const connected = ctx.connectReport(targetPath);
        if (!connected.success) {
          if (overwrite) {
            rollbackMaterializedDefinition(pulled);
            ctx.connectReport(targetPath);
          }
          return fail(connected.error ?? "Pulled report but failed to connect it.", {
            reportPath: pulled.reportPath,
            rolledBack: overwrite,
          });
        }
      }
      invalidateAll();
      invalidateCache(targetPath);
      const cleanup = finalizeMaterializedDefinition(pulled);
      return ok({
        action: overwrite ? "overwritten" : "pulled",
        format,
        ...source,
        reportUrl: `${appBase}/groups/${workspaceId}/reports/${reportId}`,
        item: itemProbe.value,
        reportPath: pulled.reportPath,
        fileCount: pulled.fileCount,
        totalBytes: pulled.totalBytes,
        connected: shouldConnect,
        overwritten: overwrite,
        backupRemoved: cleanup.backupRemoved,
        backupPath: cleanup.backupPath,
        warning: cleanup.warning,
      });
    }
  );

  server.tool(
    "pbir_fabric_diff_report",
    "Compare a local .Report folder or pulled definition JSON with the exact live Fabric report. Returns a human-readable hierarchy: report settings, pages, then components with filters, colours, layout, bindings, formatting, and other changes.",
    {
      workspaceId: z.string().uuid(),
      reportId: z.string().uuid(),
      sourcePath: z.string().optional().describe("Absolute local .Report folder or JSON snapshot; defaults to the connected report"),
      includeUnchanged: z.boolean().optional().default(false).describe("Include unchanged pages and components in the hierarchy"),
      saveLiveJsonPath: z.string().optional().describe("Optional new absolute .json path for the exact live definition snapshot"),
    },
    { openWorldHint: true },
    async ({ workspaceId, reportId, sourcePath, includeUnchanged, saveLiveJsonPath }) => {
      const resolvedSource = sourcePath ?? ctx.getReportPath();
      if (!resolvedSource) return fail("No local comparison source supplied. Connect a report or pass sourcePath.");
      if (sourcePath && !path.isAbsolute(sourcePath)) return fail("sourcePath must be absolute.");
      if (saveLiveJsonPath && !path.isAbsolute(saveLiveJsonPath)) return fail("saveLiveJsonPath must be absolute.");
      if (saveLiveJsonPath && !saveLiveJsonPath.toLowerCase().endsWith(".json")) return fail("saveLiveJsonPath must end with .json.");

      const localParts = readDefinitionParts(resolvedSource);
      const definition = await ctx.fabricApi.getReportDefinition(workspaceId, reportId);
      const liveParts = getDefinitionParts(definition);
      if (!liveParts.length) return fail("Fabric returned no PBIR definition parts for this report.");
      const liveSnapshot = saveLiveJsonPath
        ? writeDefinitionSnapshot(definition, saveLiveJsonPath, { workspaceId, reportId })
        : undefined;
      const itemProbe = await ctx.fabricApi.probe(() => ctx.fabricApi.getItem(workspaceId, reportId));
      const appBase = (process.env.PBIR_POWERBI_APP_BASE ?? "https://app.powerbi.com").replace(/\/+$/, "");
      const diff = compareReportDefinitions(localParts, liveParts, {
        includeUnchanged,
        beforeLabel: resolvedSource,
        afterLabel: `Fabric ${workspaceId}/${reportId}`,
      });
      return ok({
        source: { path: path.resolve(resolvedSource), partCount: localParts.length },
        target: {
          workspaceId,
          reportId,
          reportUrl: `${appBase}/groups/${workspaceId}/reports/${reportId}`,
          item: itemProbe.value,
          partCount: liveParts.length,
        },
        liveSnapshot,
        ...diff,
      });
    }
  );

  server.tool(
    "pbir_fabric_mirror_style",
    "Mirror the look of an existing Power BI report from its LINK (or workspaceId+reportId): pulls the source definition, extracts a style profile (custom theme, page tabs, header/banner geometry + fills + fonts, logo/image resources, typography, per-visual-type exemplar settings) and applies the transferable parts (theme + images) to the connected report, returning banner/tab specs for the agent to replicate. IMPLICIT BEHAVIOR: when a user shares an app.powerbi.com report link while asking to build, restyle, or match a report — even without the word 'mirror' — call this tool first and use its profile. Degrades gracefully: when the source definition is not accessible (someone else's personal workspace, or no export permission) it returns access='partial' with tab names from the pages API and precise permission guidance.",
    {
      url: z.string().url().optional().describe("Any app.powerbi.com report link (groups/{ws}/reports/{id}, groups/me/...)"),
      workspaceId: z.string().optional().describe("Workspace UUID or 'me'; ignored when url is given"),
      reportId: z.string().uuid().optional().describe("Report UUID; ignored when url is given"),
      apply: z.boolean().optional().default(true).describe("Apply theme + image resources to the connected report (requires a connected report)"),
      saveProfilePath: z.string().optional().describe("Optional absolute .json path to save the extracted style profile"),
    },
    { openWorldHint: true },
    async ({ url, workspaceId, reportId, apply, saveProfilePath }) => {
      const parsed = url ? parsePowerBiReportUrl(url) : (reportId ? { workspaceId: workspaceId ?? "me", reportId } : null);
      if (!parsed) return fail("Provide an app.powerbi.com report link, or workspaceId + reportId.");
      if (saveProfilePath && !path.isAbsolute(saveProfilePath)) return fail("saveProfilePath must be absolute.");

      // resolve 'me' → the signed-in user's personal workspace (only the owner's is reachable)
      let wsId = parsed.workspaceId;
      const gaps: string[] = [];
      if (wsId === "me") {
        const personal = (await ctx.fabricApi.listWorkspaces()).find((w) => w.type === "Personal");
        if (personal) {
          wsId = String(personal.id);
          gaps.push("link points at a personal 'My workspace'; resolved to the signed-in user's own personal workspace — if the report belongs to someone else this pull will be denied");
        } else {
          return fail("Link uses groups/me but no personal workspace is reachable for the signed-in account.");
        }
      }

      const defProbe = await ctx.fabricApi.probe(() =>
        ctx.fabricApi.getReportDefinition(String(wsId), parsed.reportId)
      );

      if (defProbe.ok) {
        const parts = getDefinitionParts(defProbe.value as Record<string, unknown>);
        const profile = extractStyleProfile(
          parts.map((p) => ({ path: p.path, payload: p.payload })),
          { workspaceId: String(wsId), reportId: parsed.reportId }
        );
        profile.gaps.push(...gaps);
        let applied;
        if (apply && ctx.getReportPath()) {
          applied = applyStyleProfile(ctx.project, profile, { visual: "2.7.0", report: "3.2.0", page: "2.3.0" });
          invalidateAll();
        } else if (apply) {
          profile.gaps.push("no report connected — profile extracted but nothing applied; connect a report and re-run with apply=true");
        }
        if (saveProfilePath) fs.writeFileSync(saveProfilePath, JSON.stringify(profile, null, 2), "utf8");
        // keep the response light: exemplars can be large
        const { visualExemplars, imageResources, ...summary } = profile;
        return ok({
          ...summary,
          imageResources: imageResources.map((i) => ({ name: i.name, bytes: i.base64 ? Buffer.from(i.base64, "base64").length : 0 })),
          exemplarTypes: Object.keys(visualExemplars),
          applied,
          profilePath: saveProfilePath,
        });
      }

      // graceful degradation: definition not accessible — mirror what we can
      const pagesProbe = await ctx.fabricApi.probe(() => ctx.fabricApi.listReportPages(parsed.workspaceId, parsed.reportId));
      const tabs = pagesProbe.ok
        ? (pagesProbe.value as Array<Record<string, unknown>>).map((p, i) => ({
            name: String(p.name ?? i), displayName: String(p.displayName ?? p.name ?? i), order: Number(p.order ?? i),
          })).sort((a, b) => a.order - b.order)
        : [];
      return ok({
        access: "partial",
        source: { workspaceId: parsed.workspaceId, reportId: parsed.reportId },
        tabs,
        gaps: [
          ...gaps,
          `source definition not readable (${defProbe.status ?? "error"}): ${String(defProbe.error ?? "").slice(0, 200)}`,
          ...(pagesProbe.ok ? [] : [`pages API also failed: ${String(pagesProbe.error ?? "").slice(0, 150)}`]),
          "to unlock full mirroring: ask the owner to move/copy the report into a shared workspace you can access, grant you workspace access, or allow report download",
        ],
        guidance: "Use tabs to replicate page structure; choose a theme with pbir_set_report_theme; replicate banner/header manually.",
      });
    }
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
      semanticModelId: z.string().uuid().optional().describe("Model to include in preflight. If omitted, update mode resolves it from reportId."),
      semanticModelWorkspaceId: z.string().uuid().optional().describe("Model workspace for preflight when different from the report workspace"),
      runPreflight: z.boolean().optional().default(true).describe("Run permission/capability audit before publishing"),
      confirm: z.boolean().optional().default(false),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ workspaceId, displayName, description, folder, reportId, semanticModelId, semanticModelWorkspaceId, runPreflight, confirm }) => {
      const guard = requireProject(ctx); if (guard) return guard;
      const confirmation = requireConfirm(confirm, reportId ? "Updating this report" : "Publishing this report");
      if (confirmation) return confirmation;

      const reportPath = ctx.getReportPath()!;
      const resolvedName = displayName ?? path.basename(reportPath).replace(/\.Report$/i, "");
      let accessAudit: Awaited<ReturnType<typeof auditFabricPermissions>> | undefined;
      if (runPreflight) {
        accessAudit = await auditFabricPermissions(ctx.fabricApi, {
          account: String(ctx.fabricAuth.getStatus().account ?? "") || undefined,
          workspaceId,
          reportId,
          semanticModelId: semanticModelId ?? readSemanticModelId(reportPath),
          semanticModelWorkspaceId,
        });
        const blockingProfiles = [reportId ? accessAudit.profiles.reportEditor : accessAudit.profiles.publisher];
        if (accessAudit.profiles.builder !== "notRequested") blockingProfiles.push(accessAudit.profiles.builder);
        if (blockingProfiles.includes("blocked")) {
          return fail("Fabric access preflight found verified blockers. Resolve the listed directives before publishing.", {
            accessAudit,
          });
        }
      }
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
        accessAudit,
      });
    }
  );
}

function readSemanticModelId(reportPath: string): string | undefined {
  try {
    const definition = JSON.parse(fs.readFileSync(path.join(reportPath, "definition.pbir"), "utf8"));
    const connection = definition?.datasetReference?.byConnection?.connectionString;
    return typeof connection === "string"
      ? /(?:^|;)\s*semanticmodelid\s*=\s*([^;]+)/i.exec(connection)?.[1]?.replace(/^"|"$/g, "").trim()
      : undefined;
  } catch {
    return undefined;
  }
}
