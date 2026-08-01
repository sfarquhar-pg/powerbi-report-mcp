import type { FabricApiClient, DefinitionPart, ApiProbe } from "./fabricApi.js";

export type AuditStatus = "pass" | "fail" | "unknown" | "warning" | "skipped";
export type EvidenceLevel = "verified" | "declared" | "inferred" | "unknown";

export interface AuditCheck {
  id: string;
  status: AuditStatus;
  evidence: EvidenceLevel;
  message: string;
  directive?: string;
}

export interface PermissionAuditResult {
  account?: string;
  workspaceId: string;
  reportId?: string;
  semanticModelId?: string;
  semanticModelWorkspaceId?: string;
  checks: AuditCheck[];
  profiles: Record<string, "ready" | "blocked" | "unknown" | "notRequested">;
  recommendedBaseline: string[];
  resources: {
    report?: Record<string, unknown>;
    semanticModel?: Record<string, unknown>;
  };
}

const CONTRIBUTOR_ROLES = new Set(["Admin", "Member", "Contributor"]);

export async function auditFabricPermissions(
  api: FabricApiClient,
  input: {
    account?: string;
    workspaceId: string;
    reportId?: string;
    semanticModelId?: string;
    semanticModelWorkspaceId?: string;
  }
): Promise<PermissionAuditResult> {
  const checks: AuditCheck[] = [];
  const account = input.account?.toLowerCase();
  const workspace = await api.probe(() => api.getPowerBiWorkspace(input.workspaceId));
  checks.push(capabilityCheck(
    "workspace.read",
    workspace,
    "Workspace is readable.",
    "Workspace is not readable.",
    "Ask a workspace admin for at least Viewer access, or direct access to the required report and semantic model."
  ));

  let report: Record<string, unknown> | undefined;
  let semanticModelId = input.semanticModelId;
  let semanticModelWorkspaceId = input.semanticModelWorkspaceId ?? input.workspaceId;
  if (input.reportId) {
    const reportProbe = await api.probe(() => api.getPowerBiReport(input.workspaceId, input.reportId!));
    report = reportProbe.value;
    if (!semanticModelId && reportProbe.value?.datasetId) semanticModelId = String(reportProbe.value.datasetId);
    if (!input.semanticModelWorkspaceId && reportProbe.value?.datasetWorkspaceId) {
      semanticModelWorkspaceId = String(reportProbe.value.datasetWorkspaceId);
    }
    checks.push(capabilityCheck(
      "report.read",
      reportProbe,
      "Report is readable.",
      "Report is not readable.",
      "Request report Read access or at least Viewer access to its workspace."
    ));

    const definitionProbe = await api.probe(() => api.getReportDefinition(input.workspaceId, input.reportId!));
    checks.push(capabilityCheck(
      "report.edit",
      definitionProbe,
      "Report definition is readable, proving report read/write capability for PBIR editing.",
      "Report definition cannot be read with the current account.",
      "Request report ReadWrite access or Contributor (or higher) in the report workspace."
    ));
  } else {
    checks.push({ id: "report.read", status: "skipped", evidence: "unknown", message: "No report ID supplied." });
    checks.push({ id: "report.edit", status: "skipped", evidence: "unknown", message: "No report ID supplied." });
  }

  let semanticModel: Record<string, unknown> | undefined;
  if (semanticModelId) {
    const modelProbe = await api.probe(() => api.getPowerBiDataset(semanticModelWorkspaceId, semanticModelId!));
    semanticModel = modelProbe.value;
    checks.push(capabilityCheck(
      "semanticModel.read",
      modelProbe,
      "Semantic model is readable.",
      "Semantic model is not readable.",
      "Request semantic-model Read access, or at least Viewer access to the model workspace."
    ));

    const directAccessProbe = await api.probe(() => api.listPowerBiDatasetUsers(semanticModelWorkspaceId, semanticModelId!));
    const directModelAccess = account && directAccessProbe.value
      ? directAccessProbe.value.find((entry) => String(entry.identifier ?? "").toLowerCase() === account)
      : undefined;
    checks.push({
      id: "semanticModel.directAccess",
      status: directModelAccess ? "pass" : "unknown",
      evidence: directModelAccess ? "declared" : "unknown",
      message: directModelAccess
        ? `Direct semantic-model access: ${String(directModelAccess.datasetUserAccessRight ?? "unknown")}.`
        : directAccessProbe.ok
          ? "No direct user ACL entry was found. Access may be inherited through a workspace role, app, share, or Entra group."
          : "The current account cannot enumerate semantic-model ACLs; this does not imply missing access.",
    });

    const buildProbe = await api.probe(() => api.executeDatasetQuery(
      semanticModelWorkspaceId,
      semanticModelId!,
      'EVALUATE ROW("__pbir_permission_check", 1)'
    ));
    checks.push(capabilityCheck(
      "semanticModel.build",
      buildProbe,
      "A zero-sensitive-data DAX capability probe succeeded, verifying semantic-model Build/query access.",
      "The semantic-model Build/query capability probe failed.",
      "Ask the semantic-model owner to grant Build permission via Manage permissions > Direct access, or grant Contributor (or higher) in the model workspace. Also verify the tenant setting 'Dataset Execute Queries REST API' is enabled."
    ));

    const modelDefinitionProbe = await api.probe(() => api.getSemanticModelDefinition(semanticModelWorkspaceId, semanticModelId!));
    checks.push(capabilityCheck(
      "semanticModel.edit",
      modelDefinitionProbe,
      "Semantic-model definition is readable, proving model read/write capability.",
      "Semantic-model definition cannot be read with the current account.",
      "Request semantic-model ReadWrite access or Contributor (or higher) in the model workspace."
    ));
  } else {
    checks.push({ id: "semanticModel.read", status: "skipped", evidence: "unknown", message: "No semantic model ID could be resolved." });
    checks.push({ id: "semanticModel.build", status: "skipped", evidence: "unknown", message: "No semantic model ID could be resolved." });
    checks.push({ id: "semanticModel.edit", status: "skipped", evidence: "unknown", message: "No semantic model ID could be resolved." });
  }

  const workspaceUsers = await api.probe(() => api.listPowerBiWorkspaceUsers(input.workspaceId));
  const direct = account && workspaceUsers.value
    ? workspaceUsers.value.find((entry) =>
        String(entry.identifier ?? entry.emailAddress ?? "").toLowerCase() === account
      )
    : undefined;
  if (direct) {
    const role = String(direct.groupUserAccessRight ?? "None");
    checks.push({
      id: "workspace.publish",
      status: CONTRIBUTOR_ROLES.has(role) ? "pass" : "unknown",
      evidence: "declared",
      message: `Direct workspace role: ${role}.`,
      directive: CONTRIBUTOR_ROLES.has(role) ? undefined : "This direct role does not prove publishability because an Entra group may grant a higher role. Confirm effective Contributor (or higher) in the destination workspace. Publishing can also require Power BI Pro/PPU depending on capacity and tenant policy.",
    });
  } else {
    checks.push({
      id: "workspace.publish",
      status: "unknown",
      evidence: workspaceUsers.ok ? "unknown" : "unknown",
      message: workspaceUsers.ok
        ? "No direct user role was found. Access may be inherited through an Entra group, which this audit does not expand."
        : "Workspace assignments could not be listed with the current account.",
      directive: "For publishability, confirm Contributor (or higher) in the destination workspace, directly or through an Entra group, plus any required Pro/PPU license."
    });
  }

  return {
    account: input.account,
    workspaceId: input.workspaceId,
    reportId: input.reportId,
    semanticModelId,
    semanticModelWorkspaceId,
    checks,
    profiles: {
      viewer: profile(checks, ["workspace.read", ...(input.reportId ? ["report.read"] : []), ...(semanticModelId ? ["semanticModel.read"] : [])]),
      builder: semanticModelId ? profile(checks, ["semanticModel.read", "semanticModel.build"]) : "notRequested",
      reportEditor: input.reportId ? profile(checks, ["report.edit", ...(semanticModelId ? ["semanticModel.build"] : [])]) : "notRequested",
      publisher: profile(checks, ["workspace.publish", ...(semanticModelId ? ["semanticModel.build"] : [])]),
      modelEditor: semanticModelId ? profile(checks, ["semanticModel.edit"]) : "notRequested",
    },
    recommendedBaseline: [
      "View: report Read plus semantic-model Read.",
      "Build or edit a thin report: semantic-model Build plus report ReadWrite or Contributor in the report workspace.",
      "Publish: Contributor (or higher) in the destination workspace; Power BI Pro/PPU may be required depending on capacity and tenant policy.",
      "Edit the semantic model: semantic-model ReadWrite or Contributor (or higher) in the model workspace.",
      "Manage permissions: typically Member/Admin or item Reshare/owner rights.",
    ],
    resources: {
      report: report ? {
        id: report.id,
        name: report.name,
        format: report.format,
        isOwnedByMe: report.isOwnedByMe,
        semanticModelId: report.datasetId,
      } : undefined,
      semanticModel: semanticModel ? {
        id: semanticModel.id,
        name: semanticModel.name,
        isEffectiveIdentityRequired: semanticModel.isEffectiveIdentityRequired,
        isEffectiveIdentityRolesRequired: semanticModel.isEffectiveIdentityRolesRequired,
      } : undefined,
    },
  };
}

function capabilityCheck<T>(
  id: string,
  probe: ApiProbe<T>,
  success: string,
  failure: string,
  directive: string
): AuditCheck {
  return probe.ok
    ? { id, status: "pass", evidence: "verified", message: success }
    : { id, status: "fail", evidence: "verified", message: `${failure} ${summarizeError(probe.error)}`, directive };
}

function profile(checks: AuditCheck[], ids: string[]): "ready" | "blocked" | "unknown" {
  const relevant = ids.map((id) => checks.find((check) => check.id === id)).filter(Boolean) as AuditCheck[];
  if (relevant.some((check) => check.status === "fail")) return "blocked";
  if (relevant.some((check) => check.status === "unknown" || check.status === "skipped")) return "unknown";
  return "ready";
}

export interface ReportReference {
  table: string;
  field: string;
  fieldType: "column" | "measure" | "aggregation" | "hierarchy";
  partPath: string;
  pageId?: string;
  pageName?: string;
  visualId?: string;
  visualType?: string;
  visualTitle?: string;
}

export interface LiveErrorReview {
  ok: boolean;
  workspaceId: string;
  reportId: string;
  semanticModelId?: string;
  semanticModelWorkspaceId?: string;
  referencesChecked: number;
  componentsChecked: number;
  issues: Array<Record<string, unknown>>;
  capability: Record<string, unknown>;
  note: string;
}

export async function reviewLiveReportErrors(
  api: FabricApiClient,
  input: { workspaceId: string; reportId: string; semanticModelId?: string; semanticModelWorkspaceId?: string }
): Promise<LiveErrorReview> {
  const report = await api.getPowerBiReport(input.workspaceId, input.reportId);
  const semanticModelId = input.semanticModelId ?? (report.datasetId ? String(report.datasetId) : undefined);
  const semanticModelWorkspaceId = input.semanticModelWorkspaceId ??
    (report.datasetWorkspaceId ? String(report.datasetWorkspaceId) : input.workspaceId);
  if (!semanticModelId) throw new Error("The report does not expose an underlying semantic model ID. Pass semanticModelId explicitly.");

  const definition = await api.getReportDefinition(input.workspaceId, input.reportId);
  const parts = getParts(definition);
  const references = extractReportReferences(parts);
  const issues: Array<Record<string, unknown>> = [];

  const buildProbe = await api.probe(() => api.executeDatasetQuery(
    semanticModelWorkspaceId,
    semanticModelId,
    'EVALUATE ROW("__pbir_permission_check", 1)'
  ));
  if (!buildProbe.ok) {
    issues.push({
      code: "semantic_model_build_unavailable",
      severity: "error",
      message: "Semantic-model Build/query capability is unavailable, so live field validation could not run.",
      directive: "Grant Build permission or enable the tenant's Dataset Execute Queries REST API setting.",
      technical: summarizeError(buildProbe.error),
    });
    return {
      ok: false,
      workspaceId: input.workspaceId,
      reportId: input.reportId,
      semanticModelId,
      semanticModelWorkspaceId,
      referencesChecked: 0,
      componentsChecked: new Set(references.map(componentKey)).size,
      issues,
      capability: { semanticModelBuild: "blocked" },
      note: "No report data rows were queried. The capability probe returns one synthetic constant only.",
    };
  }

  const modelDefinitionProbe = await api.probe(() => api.getSemanticModelDefinition(semanticModelWorkspaceId, semanticModelId));
  const inventory = modelDefinitionProbe.ok ? extractTmdlInventory(getParts(modelDefinitionProbe.value)) : undefined;
  const byTable = new Map<string, ReportReference[]>();
  for (const reference of references.filter((item) => item.fieldType !== "measure")) {
    const list = byTable.get(reference.table) ?? [];
    list.push(reference);
    byTable.set(reference.table, list);
  }

  for (const [table, tableReferences] of byTable) {
    const fields = [...new Set(tableReferences.map((reference) => reference.field))];
    const query = buildZeroRowCompileQuery(table, fields);
    const probe = await api.probe(() => api.executeDatasetQuery(semanticModelWorkspaceId, semanticModelId, query));
    if (!probe.ok) {
      const tableProbe = await api.probe(() => api.executeDatasetQuery(
        semanticModelWorkspaceId,
        semanticModelId,
        `EVALUATE TOPN(0, '${table.replace(/'/g, "''")}')`
      ));
      const metadataHasTable = inventory?.tables.has(table);
      if (!tableProbe.ok) {
        issues.push({
          code: metadataHasTable ? "model_runtime_metadata_mismatch" : "missing_table_reference",
          severity: "error",
          table,
          fields,
          message: metadataHasTable
            ? `The semantic-model definition contains '${table}', but the live query runtime cannot resolve it.`
            : `The live semantic model cannot resolve table '${table}'.`,
          components: dedupeComponents(tableReferences),
          directive: metadataHasTable
            ? "Ask the semantic-model owner to verify the deployed model/runtime state, refresh or republish the semantic model, and confirm the report is bound to the intended model/version."
            : "Correct the PBIR table binding or publish the missing table to the semantic model.",
          technical: summarizeError(tableProbe.error ?? probe.error),
        });
      } else {
        const brokenFields: string[] = [];
        for (const field of fields) {
          const fieldProbe = await api.probe(() => api.executeDatasetQuery(
            semanticModelWorkspaceId,
            semanticModelId,
            buildZeroRowCompileQuery(table, [field])
          ));
          if (!fieldProbe.ok) brokenFields.push(field);
        }
        issues.push({
          code: "missing_field_reference",
          severity: "error",
          table,
          fields: brokenFields.length ? brokenFields : fields,
          message: `The table exists, but one or more referenced fields cannot compile in the live semantic model.`,
          components: dedupeComponents(tableReferences.filter((reference) =>
            !brokenFields.length || brokenFields.includes(reference.field)
          )),
          directive: "Correct the PBIR field binding or publish the missing field to the semantic model.",
          technical: summarizeError(probe.error),
        });
      }
      continue;
    }

    if (inventory) {
      const modelFields = inventory.tables.get(table);
      const missing = fields.filter((field) => !modelFields?.columns.has(field));
      if (missing.length) {
        issues.push({
          code: "definition_missing_reference",
          severity: "error",
          table,
          fields: missing,
          message: "The report references fields absent from the semantic-model TMDL definition.",
          components: dedupeComponents(tableReferences.filter((reference) => missing.includes(reference.field))),
          directive: "Correct the PBIR bindings or add the fields to the semantic model.",
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    workspaceId: input.workspaceId,
    reportId: input.reportId,
    semanticModelId,
    semanticModelWorkspaceId,
    referencesChecked: references.length,
    componentsChecked: new Set(references.map(componentKey)).size,
    issues,
    capability: {
      semanticModelBuild: "verified",
      reportDefinitionReadWrite: "verified",
      semanticModelDefinitionReadWrite: modelDefinitionProbe.ok ? "verified" : "notAvailable",
    },
    note: "Field probes use TOPN(0) and return no semantic-model data rows.",
  };
}

function getParts(value: unknown): DefinitionPart[] {
  const candidate = value as { definition?: { parts?: DefinitionPart[] } } | undefined;
  return candidate?.definition?.parts ?? [];
}

export function extractReportReferences(parts: DefinitionPart[]): ReportReference[] {
  const pages = new Map<string, string>();
  for (const part of parts) {
    const pageMatch = /^definition\/pages\/([^/]+)\/page\.json$/.exec(part.path);
    if (!pageMatch) continue;
    const page = decodeJson(part);
    pages.set(pageMatch[1], String(page?.displayName ?? pageMatch[1]));
  }

  const results: ReportReference[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const visualMatch = /^definition\/pages\/([^/]+)\/visuals\/([^/]+)\/visual\.json$/.exec(part.path);
    if (!visualMatch) continue;
    const visual = decodeJson(part);
    const context = {
      partPath: part.path,
      pageId: visualMatch[1],
      pageName: pages.get(visualMatch[1]),
      visualId: visualMatch[2],
      visualType: String(visual?.visual?.visualType ?? "unknown"),
      visualTitle: readVisualTitle(visual),
    };
    walkFields(visual, context, results, seen);
  }
  return results;
}

function walkFields(
  value: unknown,
  context: Omit<ReportReference, "table" | "field" | "fieldType">,
  output: ReportReference[],
  seen: Set<string>
): void {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, any>;
  const refs: Array<{ fieldType: ReportReference["fieldType"]; node: any }> = [
    { fieldType: "column", node: object.Column },
    { fieldType: "measure", node: object.Measure },
    { fieldType: "aggregation", node: object.Aggregation?.Expression?.Column },
  ];
  for (const { fieldType, node } of refs) {
    const table = node?.Expression?.SourceRef?.Entity;
    const field = node?.Property;
    if (!table || !field) continue;
    const key = `${context.partPath}|${table}|${field}|${fieldType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...context, table, field, fieldType });
  }
  const hierarchy = object.HierarchyLevel;
  const hierarchyTable = hierarchy?.Expression?.Hierarchy?.Expression?.SourceRef?.Entity;
  if (hierarchyTable && hierarchy?.Level) {
    const key = `${context.partPath}|${hierarchyTable}|${hierarchy.Level}|hierarchy`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ ...context, table: hierarchyTable, field: hierarchy.Level, fieldType: "hierarchy" });
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(object)) {
    walkFields(child, context, output, seen);
  }
}

function decodeJson(part: DefinitionPart): any {
  return JSON.parse(Buffer.from(part.payload, "base64").toString("utf8"));
}

function readVisualTitle(visual: any): string | undefined {
  const literal = visual?.visual?.visualContainerObjects?.title?.[0]?.properties?.text?.expr?.Literal?.Value;
  return typeof literal === "string" ? literal.replace(/^'(.*)'$/, "$1").replace(/''/g, "'") : undefined;
}

function buildZeroRowCompileQuery(table: string, fields: string[]): string {
  const tableRef = `'${table.replace(/'/g, "''")}'`;
  const projections = fields.map((field, index) =>
    `"__pbir_${index}", ${tableRef}[${field.replace(/]/g, "]]" )}]`
  );
  return `EVALUATE SELECTCOLUMNS(TOPN(0, ${tableRef}), ${projections.join(", ")})`;
}

function extractTmdlInventory(parts: DefinitionPart[]): { tables: Map<string, { columns: Set<string>; measures: Set<string> }> } {
  const tables = new Map<string, { columns: Set<string>; measures: Set<string> }>();
  for (const part of parts.filter((item) => item.path.toLowerCase().endsWith(".tmdl"))) {
    const text = Buffer.from(part.payload, "base64").toString("utf8");
    const tableMatch = /^\s*table\s+(.+?)\s*$/m.exec(text);
    if (!tableMatch) continue;
    const table = unquoteTmdl(tableMatch[1]);
    const entry = tables.get(table) ?? { columns: new Set<string>(), measures: new Set<string>() };
    for (const match of text.matchAll(/^\s*column\s+(.+?)(?:\s*=|\s*$)/gm)) entry.columns.add(unquoteTmdl(match[1]));
    for (const match of text.matchAll(/^\s*measure\s+(.+?)\s*=/gm)) entry.measures.add(unquoteTmdl(match[1]));
    tables.set(table, entry);
  }
  return { tables };
}

function unquoteTmdl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("'") && trimmed.endsWith("'")
    ? trimmed.slice(1, -1).replace(/''/g, "'")
    : trimmed;
}

function componentKey(reference: ReportReference): string {
  return `${reference.pageId}|${reference.visualId}`;
}

function dedupeComponents(references: ReportReference[]): Array<Record<string, unknown>> {
  const components = new Map<string, Record<string, unknown>>();
  for (const reference of references) {
    components.set(componentKey(reference), {
      pageId: reference.pageId,
      pageName: reference.pageName,
      visualId: reference.visualId,
      visualType: reference.visualType,
      visualTitle: reference.visualTitle,
    });
  }
  return [...components.values()];
}

function summarizeError(error?: string): string {
  if (!error) return "No technical detail was returned.";
  return error.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").slice(0, 600);
}
