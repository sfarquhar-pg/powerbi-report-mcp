import * as fs from "fs";
import * as path from "path";
import type { FabricAuthManager } from "./fabricAuth.js";

export interface FabricFolder {
  id: string;
  displayName: string;
  workspaceId: string;
  parentFolderId?: string;
  legacyId?: number;
}

export interface DefinitionPart {
  path: string;
  payload: string;
  payloadType: "InlineBase64";
}

export interface ApiProbe<T = unknown> {
  ok: boolean;
  status?: number;
  value?: T;
  error?: string;
}

export class FabricApiClient {
  private readonly fabricApiBase: string;
  private readonly powerBiApiBase: string;

  constructor(
    private readonly auth: FabricAuthManager,
    private readonly fetcher: typeof fetch = fetch,
    options: { fabricApiBase?: string; powerBiApiBase?: string } = {}
  ) {
    this.fabricApiBase = trimTrailingSlash(
      options.fabricApiBase ?? process.env.PBIR_FABRIC_API_BASE ?? "https://api.fabric.microsoft.com/v1"
    );
    this.powerBiApiBase = trimTrailingSlash(
      options.powerBiApiBase ?? process.env.PBIR_POWERBI_API_BASE ?? "https://api.powerbi.com"
    );
  }

  async resolveFolder(workspaceId: string, identifier: string): Promise<FabricFolder> {
    const folders = await this.listFolders(workspaceId);
    const normalized = identifier.trim();
    const byUuid = folders.find((folder) => folder.id.toLowerCase() === normalized.toLowerCase());
    if (byUuid) return byUuid;

    if (/^\d+$/.test(normalized)) {
      const legacy = await this.listLegacyFolders(workspaceId);
      const match = legacy.find((folder) => folder.legacyId === Number(normalized));
      if (!match) throw new Error(`No Fabric folder matches legacy subfolder ID ${identifier}.`);
      return match;
    }

    const byName = folders.filter((folder) => folder.displayName.toLowerCase() === normalized.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Folder name '${identifier}' is ambiguous. Use its UUID.`);
    throw new Error(`No Fabric folder named '${identifier}' was found in workspace ${workspaceId}.`);
  }

  async listReports(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.requestJson<{ value?: Array<Record<string, unknown>> }>(
      "fabric",
      `${this.fabricApiBase}/workspaces/${workspaceId}/items?type=Report&recursive=true`
    );
    return result.value ?? [];
  }

  async listWorkspaces(): Promise<Array<Record<string, unknown>>> {
    const result = await this.requestJson<{ value?: Array<Record<string, unknown>> }>(
      "fabric",
      `${this.fabricApiBase}/workspaces`
    );
    return result.value ?? [];
  }

  async listReportPages(workspaceId: string | "me", reportId: string): Promise<Array<Record<string, unknown>>> {
    const scope = workspaceId === "me" ? "" : `groups/${workspaceId}/`;
    const result = await this.requestJson<{ value?: Array<Record<string, unknown>> }>(
      "powerbi",
      `${this.powerBiApiBase}/v1.0/myorg/${scope}reports/${reportId}/pages`
    );
    return result.value ?? [];
  }

  async publishReport(input: {
    workspaceId: string;
    displayName: string;
    description?: string;
    folderId?: string;
    reportId?: string;
    parts: DefinitionPart[];
  }): Promise<Record<string, unknown>> {
    const definition = { format: "PBIR", parts: input.parts };
    if (input.reportId) {
      await this.requestJson(
        "fabric",
        `${this.fabricApiBase}/workspaces/${input.workspaceId}/items/${input.reportId}/updateDefinition`,
        { method: "POST", body: JSON.stringify({ definition }) }
      );
      return this.getItem(input.workspaceId, input.reportId);
    }

    return this.requestJson(
      "fabric",
      `${this.fabricApiBase}/workspaces/${input.workspaceId}/reports`,
      {
        method: "POST",
        body: JSON.stringify({
          displayName: input.displayName,
          description: input.description,
          folderId: input.folderId,
          definition,
        }),
      }
    );
  }

  async getItem(workspaceId: string, itemId: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "fabric",
      `${this.fabricApiBase}/workspaces/${workspaceId}/items/${itemId}`
    );
  }

  async getPowerBiWorkspace(workspaceId: string): Promise<Record<string, unknown>> {
    return this.requestJson("powerbi", `${this.powerBiApiBase}/v1.0/myorg/groups/${workspaceId}`);
  }

  async getPowerBiReport(workspaceId: string, reportId: string): Promise<Record<string, unknown>> {
    return this.requestJson("powerbi", `${this.powerBiApiBase}/v1.0/myorg/groups/${workspaceId}/reports/${reportId}`);
  }

  async getPowerBiDataset(workspaceId: string, semanticModelId: string): Promise<Record<string, unknown>> {
    return this.requestJson("powerbi", `${this.powerBiApiBase}/v1.0/myorg/groups/${workspaceId}/datasets/${semanticModelId}`);
  }

  async listPowerBiWorkspaceUsers(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.requestJson<{ value?: Array<Record<string, unknown>> }>(
      "powerbi",
      `${this.powerBiApiBase}/v1.0/myorg/groups/${workspaceId}/users`
    );
    return result.value ?? [];
  }

  async listPowerBiDatasetUsers(
    workspaceId: string,
    semanticModelId: string
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.requestJson<{ value?: Array<Record<string, unknown>> }>(
      "powerbi",
      `${this.powerBiApiBase}/v1.0/myorg/groups/${workspaceId}/datasets/${semanticModelId}/users`
    );
    return result.value ?? [];
  }

  async executeDatasetQuery(
    workspaceId: string,
    semanticModelId: string,
    query: string
  ): Promise<Record<string, unknown>> {
    return this.requestJson(
      "powerbi",
      `${this.powerBiApiBase}/v1.0/myorg/groups/${workspaceId}/datasets/${semanticModelId}/executeQueries`,
      {
        method: "POST",
        body: JSON.stringify({
          queries: [{ query }],
          serializerSettings: { includeNulls: false },
        }),
      }
    );
  }

  async getReportDefinition(workspaceId: string, reportId: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      "fabric",
      `${this.fabricApiBase}/workspaces/${workspaceId}/reports/${reportId}/getDefinition?format=PBIR`,
      { method: "POST" }
    );
  }

  async getSemanticModelDefinition(
    workspaceId: string,
    semanticModelId: string
  ): Promise<Record<string, unknown>> {
    return this.requestJson(
      "fabric",
      `${this.fabricApiBase}/workspaces/${workspaceId}/semanticModels/${semanticModelId}/getDefinition?format=TMDL`,
      { method: "POST" }
    );
  }

  async probe<T>(operation: () => Promise<T>): Promise<ApiProbe<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /Fabric API (\d{3})/.exec(message)?.[1];
      return { ok: false, status: status ? Number(status) : undefined, error: message };
    }
  }

  private async listFolders(workspaceId: string): Promise<FabricFolder[]> {
    const result = await this.requestJson<{ value?: FabricFolder[] }>(
      "fabric",
      `${this.fabricApiBase}/workspaces/${workspaceId}/folders`
    );
    return result.value ?? [];
  }

  private async listLegacyFolders(workspaceId: string): Promise<FabricFolder[]> {
    const result = await this.requestJson<{
      subfolders?: Array<{
        id: number;
        displayName: string;
        objectId: string;
        parentSubfolderId?: number;
      }>;
    }>("powerbi", `${this.powerBiApiBase}/metadata/folders/${workspaceId}/subfolders`);
    return (result.subfolders ?? []).map((folder) => ({
      id: folder.objectId,
      displayName: folder.displayName,
      workspaceId,
      legacyId: folder.id,
    }));
  }

  private async requestJson<T = Record<string, unknown>>(
    resource: "fabric" | "powerbi",
    url: string,
    init: RequestInit = {}
  ): Promise<T> {
    const token = await this.auth.getToken(resource);
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    if (response.status === 204) return {} as T;
    if (!response.ok && response.status !== 202) {
      throw new Error(`Fabric API ${response.status}: ${body || response.statusText}`);
    }
    if (response.status === 202) {
      const operationId = response.headers.get("x-ms-operation-id");
      if (!operationId) throw new Error("Fabric API returned 202 without x-ms-operation-id.");
      return this.pollOperation<T>(operationId, resource);
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  private async pollOperation<T>(operationId: string, resource: "fabric" | "powerbi"): Promise<T> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const state = await this.requestJson<{
        status?: string;
        error?: unknown;
      }>(resource, `${this.fabricApiBase}/operations/${operationId}`);
      if (state.status === "Failed") throw new Error(`Fabric operation failed: ${JSON.stringify(state.error)}`);
      if (state.status === "Succeeded") {
        try {
          return await this.requestJson<T>(resource, `${this.fabricApiBase}/operations/${operationId}/result`);
        } catch (error) {
          if (error instanceof Error && error.message.includes("OperationHasNoResult")) return {} as T;
          throw error;
        }
      }
    }
    throw new Error(`Fabric operation ${operationId} did not finish within 120 seconds.`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function collectReportDefinitionParts(reportPath: string): DefinitionPart[] {
  const root = path.resolve(reportPath);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to publish symlinked report part: ${fullPath}`);
      if (entry.isDirectory()) walk(fullPath);
      else files.push(fullPath);
    }
  };
  walk(root);
  return files.sort().map((filePath) => ({
    path: path.relative(root, filePath).split(path.sep).join("/"),
    payload: fs.readFileSync(filePath).toString("base64"),
    payloadType: "InlineBase64",
  }));
}
