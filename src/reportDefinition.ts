import * as fs from "fs";
import * as path from "path";
import { collectReportDefinitionParts, type DefinitionPart } from "./fabricApi.js";

export interface MaterializedDefinition {
  reportPath: string;
  fileCount: number;
  totalBytes: number;
  files: string[];
  backupPath?: string;
}

export interface DefinitionSnapshotSource {
  workspaceId: string;
  reportId: string;
}

export interface MaterializeDefinitionOptions {
  overwrite?: boolean;
}

export function getDefinitionParts(value: unknown): DefinitionPart[] {
  const candidate = value as {
    definition?: { parts?: unknown };
    parts?: unknown;
  } | undefined;
  const raw = candidate?.definition?.parts ?? candidate?.parts;
  if (!Array.isArray(raw)) return [];

  const parts = raw.map((part, index): DefinitionPart => {
    if (!part || typeof part !== "object") throw new Error(`Definition part ${index} is not an object.`);
    const item = part as Record<string, unknown>;
    if (typeof item.path !== "string" || !item.path) throw new Error(`Definition part ${index} has no path.`);
    if (typeof item.payload !== "string") throw new Error(`Definition part '${item.path}' has no payload.`);
    if (item.payloadType !== "InlineBase64") {
      throw new Error(`Definition part '${item.path}' uses unsupported payload type '${String(item.payloadType)}'.`);
    }
    return { path: item.path, payload: item.payload, payloadType: "InlineBase64" };
  });
  return validateDefinitionParts(parts);
}

export function materializeDefinitionParts(
  parts: DefinitionPart[],
  targetPath: string,
  options: MaterializeDefinitionOptions = {}
): MaterializedDefinition {
  if (!path.isAbsolute(targetPath)) throw new Error("Pull target path must be absolute.");
  if (options.overwrite) recoverInterruptedReportReplacement(targetPath);
  const validated = validateParts(parts);
  assertReportDefinition(validated);
  if (options.overwrite) assertReplaceableReportDirectory(targetPath);
  else assertAvailableDirectory(targetPath);

  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(targetPath)}.pull-`));
  const backupPath = `${temporary}.previous`;
  let backupCreated = false;
  try {
    for (const item of validated) {
      const destination = path.join(temporary, ...item.segments);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, item.content, { flag: "wx" });
    }
    if (fs.existsSync(targetPath)) {
      if (options.overwrite) {
        fs.renameSync(targetPath, backupPath);
        backupCreated = true;
      } else {
        fs.rmdirSync(targetPath);
      }
    }
    fs.renameSync(temporary, targetPath);
  } catch (error) {
    if (backupCreated && fs.existsSync(backupPath)) {
      try {
        if (fs.existsSync(targetPath)) {
          throw new Error(`Cannot restore the original report because another path now exists at: ${targetPath}`);
        }
        fs.renameSync(backupPath, targetPath);
        backupCreated = false;
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Report replacement failed and automatic rollback also failed: ${message}. ` +
          `The original report remains at backup path: ${backupPath}`,
          { cause: error }
        );
      }
    }
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }

  return {
    reportPath: targetPath,
    fileCount: validated.length,
    totalBytes: validated.reduce((sum, item) => sum + item.content.length, 0),
    files: validated.map((item) => item.path),
    backupPath: backupCreated ? backupPath : undefined,
  };
}

export function finalizeMaterializedDefinition(result: MaterializedDefinition): {
  backupRemoved: boolean;
  backupPath?: string;
  warning?: string;
} {
  if (!result.backupPath) return { backupRemoved: true };
  try {
    fs.rmSync(result.backupPath, { recursive: true });
    return { backupRemoved: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      backupRemoved: false,
      backupPath: result.backupPath,
      warning: `The published report was installed, but the previous-report backup could not be removed: ${message}`,
    };
  }
}

export function rollbackMaterializedDefinition(result: MaterializedDefinition): void {
  if (!result.backupPath || !fs.existsSync(result.backupPath)) {
    throw new Error("No previous-report backup is available for rollback.");
  }
  const failedPath = `${result.backupPath}.failed`;
  if (fs.existsSync(failedPath)) throw new Error(`Rollback staging path already exists: ${failedPath}`);

  let installedMoved = false;
  try {
    if (fs.existsSync(result.reportPath)) {
      fs.renameSync(result.reportPath, failedPath);
      installedMoved = true;
    }
    fs.renameSync(result.backupPath, result.reportPath);
  } catch (error) {
    if (installedMoved && !fs.existsSync(result.reportPath) && fs.existsSync(failedPath)) {
      try { fs.renameSync(failedPath, result.reportPath); } catch { /* surface the original rollback failure */ }
    }
    throw error;
  }
  try { fs.rmSync(failedPath, { recursive: true, force: true }); } catch { /* old report is already restored */ }
}

export function recoverInterruptedReportReplacement(targetPath: string): string | undefined {
  if (fs.existsSync(targetPath)) return undefined;
  const parent = path.dirname(targetPath);
  if (!fs.existsSync(parent)) return undefined;
  const prefix = `.${path.basename(targetPath)}.pull-`;
  const backups = fs.readdirSync(parent)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".previous"))
    .map((name) => path.join(parent, name));
  if (!backups.length) return undefined;
  if (backups.length > 1) {
    throw new Error(`Multiple interrupted report backups require manual recovery: ${backups.join(", ")}`);
  }
  const backupPath = backups[0];
  fs.renameSync(backupPath, targetPath);
  const abandonedStage = backupPath.slice(0, -".previous".length);
  try { fs.rmSync(abandonedStage, { recursive: true, force: true }); } catch { /* recovered report is usable */ }
  return backupPath;
}

export function recoverInterruptedReportReplacements(parentPath: string): string[] {
  if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) return [];
  const recovered: string[] = [];
  const marker = ".Report.pull-";
  for (const name of fs.readdirSync(parentPath)) {
    if (!name.startsWith(".") || !name.endsWith(".previous")) continue;
    const markerIndex = name.indexOf(marker);
    if (markerIndex < 0) continue;
    const reportName = name.slice(1, markerIndex + ".Report".length);
    const targetPath = path.join(parentPath, reportName);
    const restored = recoverInterruptedReportReplacement(targetPath);
    if (restored) recovered.push(restored);
  }
  return recovered;
}

function assertReportDefinition(parts: Array<{ path: string; content: Buffer }>): void {
  const byPath = new Map(parts.map((part) => [part.path, part]));
  for (const required of ["definition.pbir", "definition/report.json", "definition/pages/pages.json"]) {
    if (!byPath.has(required)) throw new Error(`Pulled definition is missing canonical PBIR part: ${required}`);
  }
  for (const part of parts.filter((item) => item.path === "definition.pbir" || item.path.toLowerCase().endsWith(".json"))) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(part.content);
      JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Pulled definition contains invalid JSON in '${part.path}': ${message}`);
    }
  }
}

export function writeDefinitionSnapshot(
  definition: unknown,
  targetPath: string,
  source: DefinitionSnapshotSource
): { snapshotPath: string; partCount: number; totalBytes: number } {
  if (!path.isAbsolute(targetPath)) throw new Error("Snapshot path must be absolute.");
  if (fs.existsSync(targetPath)) throw new Error(`Refusing to overwrite existing path: ${targetPath}`);
  const parts = getDefinitionParts(definition);
  if (!parts.length) throw new Error("The Fabric response contained no PBIR definition parts.");
  validateParts(parts);

  const candidate = definition as { definition?: unknown } | undefined;
  const snapshot = {
    schemaVersion: 1,
    source,
    definition: candidate?.definition ?? definition,
  };
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.linkSync(temporary, targetPath);
    fs.unlinkSync(temporary);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return {
    snapshotPath: targetPath,
    partCount: parts.length,
    totalBytes: parts.reduce((sum, part) => sum + decodeBase64(part.payload, part.path).length, 0),
  };
}

export function readDefinitionParts(sourcePath: string): DefinitionPart[] {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) throw new Error(`Report definition source does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    if (!resolved.endsWith(".Report")) throw new Error(`Report source directory must end with .Report: ${resolved}`);
    if (!fs.existsSync(path.join(resolved, "definition.pbir")) || !fs.existsSync(path.join(resolved, "definition", "report.json"))) {
      throw new Error(`Directory is not a PBIR report project: ${resolved}`);
    }
    return validateDefinitionParts(collectReportDefinitionParts(resolved));
  }
  if (!stat.isFile()) throw new Error(`Report definition source is not a file or directory: ${resolved}`);
  if (!resolved.toLowerCase().endsWith(".json")) throw new Error(`Definition snapshot source must end with .json: ${resolved}`);
  const snapshot = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const parts = getDefinitionParts(snapshot);
  if (!parts.length) throw new Error(`JSON snapshot contains no PBIR definition parts: ${resolved}`);
  return parts;
}

function validateDefinitionParts(parts: DefinitionPart[]): DefinitionPart[] {
  const validated = validateParts(parts);
  return validated.map((item, index) => ({
    path: item.path,
    payload: parts[index].payload,
    payloadType: "InlineBase64",
  }));
}

function validateParts(parts: DefinitionPart[]): Array<{
  path: string;
  segments: string[];
  content: Buffer;
}> {
  if (!parts.length) throw new Error("The Fabric response contained no PBIR definition parts.");
  const seen = new Set<string>();
  return parts.map((part) => {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(`Definition part '${part.path}' uses unsupported payload type '${part.payloadType}'.`);
    }
    const segments = validatePartPath(part.path);
    const key = segments.join("/").toLowerCase();
    if (seen.has(key)) throw new Error(`Definition contains duplicate path: ${part.path}`);
    seen.add(key);
    return { path: segments.join("/"), segments, content: decodeBase64(part.payload, part.path) };
  });
}

function validatePartPath(partPath: string): string[] {
  if (!partPath || partPath.includes("\\") || partPath.startsWith("/") || /^[A-Za-z]:/.test(partPath)) {
    throw new Error(`Unsafe definition part path: ${partPath}`);
  }
  const segments = partPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe definition part path: ${partPath}`);
  }
  return segments;
}

function decodeBase64(payload: string, partPath: string): Buffer {
  const compact = payload.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error(`Definition part '${partPath}' has an invalid base64 payload.`);
  }
  return Buffer.from(compact, "base64");
}

function assertAvailableDirectory(targetPath: string): void {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${targetPath}`);
  if (!stat.isDirectory()) throw new Error(`Target exists and is not a directory: ${targetPath}`);
  if (fs.readdirSync(targetPath).length) throw new Error(`Refusing to overwrite non-empty directory: ${targetPath}`);
}

function assertReplaceableReportDirectory(targetPath: string): void {
  if (!fs.existsSync(targetPath)) throw new Error(`Cannot overwrite missing report directory: ${targetPath}`);
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to replace symlinked report directory: ${targetPath}`);
  if (!stat.isDirectory()) throw new Error(`Overwrite target is not a directory: ${targetPath}`);
  if (!targetPath.endsWith(".Report")) throw new Error(`Overwrite target must end with .Report: ${targetPath}`);
  if (!fs.existsSync(path.join(targetPath, "definition.pbir")) ||
      !fs.existsSync(path.join(targetPath, "definition", "report.json"))) {
    throw new Error(`Refusing to overwrite a directory that is not a PBIR report project: ${targetPath}`);
  }
}
