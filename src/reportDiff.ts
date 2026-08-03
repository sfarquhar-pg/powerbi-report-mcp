import type { DefinitionPart } from "./fabricApi.js";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";
export type DiffKind = "added" | "removed" | "changed";

export interface ReportChange {
  kind: DiffKind;
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface ReportDiffSection {
  name: string;
  changes: ReportChange[];
}

export interface ComponentDiff {
  componentId: string;
  title?: string;
  visualType?: string;
  status: DiffStatus;
  sections: ReportDiffSection[];
}

export interface PageDiff {
  pageId: string;
  displayName: string;
  status: DiffStatus;
  sections: ReportDiffSection[];
  components: ComponentDiff[];
}

export interface ReportDefinitionDiff {
  identical: boolean;
  semanticMatch: boolean;
  matches: {
    raw: boolean;
    definition: boolean;
    semantic: boolean;
  };
  summary: {
    parts: StatusCounts & { before: number; after: number };
    pages: StatusCounts;
    components: StatusCounts;
    changeCount: number;
    changesBySection: Record<string, number>;
  };
  report: { status: DiffStatus; sections: ReportDiffSection[] };
  pages: PageDiff[];
  markdown: string;
}

interface StatusCounts {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

interface DecodedPart {
  path: string;
  bytes: Buffer;
  value: unknown;
  isJson: boolean;
}

interface SideVisual {
  id: string;
  part: DecodedPart;
}

interface SidePage {
  id: string;
  pagePart?: DecodedPart;
  parts: Map<string, DecodedPart>;
  visuals: Map<string, SideVisual>;
}

interface ReportSide {
  parts: Map<string, DecodedPart>;
  rootParts: Map<string, DecodedPart>;
  pages: Map<string, SidePage>;
  pageOrder: string[];
}

const SECTION_ORDER = [
  "Model binding",
  "Pages",
  "Filters",
  "Themes",
  "Colours",
  "Settings",
  "Metadata",
  "Layout",
  "Bindings and data",
  "Actions and interactions",
  "Formatting",
  "Bookmarks",
  "Resources",
  "Other",
];

export function compareReportDefinitions(
  beforeParts: DefinitionPart[],
  afterParts: DefinitionPart[],
  options: { includeUnchanged?: boolean; beforeLabel?: string; afterLabel?: string } = {}
): ReportDefinitionDiff {
  const before = buildSide(beforeParts);
  const after = buildSide(afterParts);
  const rawMatch = mapsEqual(before.parts, after.parts, (part) => part.bytes);
  const definitionMatch = mapsEqual(before.parts, after.parts, (part) => canonicalPart(part, false));
  const semanticMatch = mapsEqual(before.parts, after.parts, (part) => canonicalPart(part, true));

  const reportChanges = diffPartMaps(before.rootParts, after.rootParts);
  const reportSections = groupChanges(reportChanges, "report");
  const allPages = buildPageDiffs(before, after);
  const visiblePages = options.includeUnchanged
    ? allPages
    : allPages.filter((page) => page.status !== "unchanged").map((page) => ({
        ...page,
        components: page.components.filter((component) => component.status !== "unchanged"),
      }));
  const pageCounts = countStatuses(allPages);
  const allComponents = allPages.flatMap((page) => page.components);
  const componentCounts = countStatuses(allComponents);
  const partCounts = countPartStatuses(before.parts, after.parts);
  const changes = [
    ...reportSections.flatMap((section) => section.changes.map((change) => ({ section: section.name, change }))),
    ...allPages.flatMap((page) => [
      ...page.sections.flatMap((section) => section.changes.map((change) => ({ section: section.name, change }))),
      ...page.components.flatMap((component) =>
        component.sections.flatMap((section) => section.changes.map((change) => ({ section: section.name, change })))
      ),
    ]),
  ];
  const entityChanges = pageCounts.added + pageCounts.removed + componentCounts.added + componentCounts.removed;
  const changesBySection: Record<string, number> = {};
  for (const entry of changes) changesBySection[entry.section] = (changesBySection[entry.section] ?? 0) + 1;

  const result: ReportDefinitionDiff = {
    identical: definitionMatch,
    semanticMatch,
    matches: { raw: rawMatch, definition: definitionMatch, semantic: semanticMatch },
    summary: {
      parts: { before: before.parts.size, after: after.parts.size, ...partCounts },
      pages: pageCounts,
      components: componentCounts,
      changeCount: changes.length + entityChanges,
      changesBySection,
    },
    report: { status: reportChanges.length ? "changed" : "unchanged", sections: reportSections },
    pages: visiblePages,
    markdown: "",
  };
  result.markdown = formatReportDiff(
    result,
    options.beforeLabel ?? "Local",
    options.afterLabel ?? "Live",
    options.includeUnchanged ?? false
  );
  return result;
}

function buildSide(parts: DefinitionPart[]): ReportSide {
  const decoded = new Map<string, DecodedPart>();
  for (const part of parts) {
    const normalizedPath = part.path.replace(/\\/g, "/");
    const bytes = Buffer.from(part.payload, "base64");
    const text = bytes.toString("utf8");
    let value: unknown = text;
    let isJson = false;
    try {
      value = JSON.parse(text);
      isJson = true;
    } catch {
      // Non-JSON resources are compared byte-for-byte.
    }
    decoded.set(normalizedPath, { path: normalizedPath, bytes, value, isJson });
  }

  const pages = new Map<string, SidePage>();
  const rootParts = new Map<string, DecodedPart>();
  for (const [partPath, part] of decoded) {
    const pageMatch = /^definition\/pages\/([^/]+)\/(.+)$/.exec(partPath);
    if (!pageMatch || partPath === "definition/pages/pages.json") {
      rootParts.set(partPath, part);
      continue;
    }
    const page = pages.get(pageMatch[1]) ?? {
      id: pageMatch[1],
      parts: new Map<string, DecodedPart>(),
      visuals: new Map<string, SideVisual>(),
    };
    const visualMatch = /^visuals\/([^/]+)\/visual\.json$/.exec(pageMatch[2]);
    if (pageMatch[2] === "page.json") page.pagePart = part;
    else if (visualMatch) page.visuals.set(visualMatch[1], { id: visualMatch[1], part });
    else page.parts.set(pageMatch[2], part);
    pages.set(page.id, page);
  }

  const metadata = asRecord(decoded.get("definition/pages/pages.json")?.value);
  const order = Array.isArray(metadata?.pageOrder)
    ? metadata.pageOrder.filter((item): item is string => typeof item === "string")
    : [];
  for (const pageId of [...pages.keys()].sort()) if (!order.includes(pageId)) order.push(pageId);
  return { parts: decoded, rootParts, pages, pageOrder: order };
}

function buildPageDiffs(before: ReportSide, after: ReportSide): PageDiff[] {
  const pageIds = orderedUnion(after.pageOrder, before.pageOrder, before.pages, after.pages);
  return pageIds.map((pageId) => {
    const oldPage = before.pages.get(pageId);
    const newPage = after.pages.get(pageId);
    if (!oldPage || !newPage) {
      const page = newPage ?? oldPage!;
      const status: DiffStatus = newPage ? "added" : "removed";
      return {
        pageId,
        displayName: pageName(page),
        status,
        sections: [],
        components: orderedVisuals(page).map((visual) => componentEntry(visual, status, [])),
      };
    }

    const pageChanges: ReportChange[] = [];
    diffDecodedParts(oldPage.pagePart, newPage.pagePart, "page.json", pageChanges);
    pageChanges.push(...diffPartMaps(oldPage.parts, newPage.parts));
    const components = buildComponentDiffs(oldPage, newPage);
    const status: DiffStatus = pageChanges.length || components.some((item) => item.status !== "unchanged")
      ? "changed"
      : "unchanged";
    return {
      pageId,
      displayName: pageName(newPage),
      status,
      sections: groupChanges(pageChanges, "page"),
      components,
    };
  });
}

function buildComponentDiffs(before: SidePage, after: SidePage): ComponentDiff[] {
  const ids = orderedVisualIds(after, before);
  return ids.map((id) => {
    const oldVisual = before.visuals.get(id);
    const newVisual = after.visuals.get(id);
    if (!oldVisual || !newVisual) {
      return componentEntry(newVisual ?? oldVisual!, newVisual ? "added" : "removed", []);
    }
    const changes: ReportChange[] = [];
    diffDecodedParts(oldVisual.part, newVisual.part, "", changes);
    return componentEntry(newVisual, changes.length ? "changed" : "unchanged", groupChanges(changes, "component"));
  });
}

function componentEntry(visual: SideVisual, status: DiffStatus, sections: ReportDiffSection[]): ComponentDiff {
  const value = asRecord(visual.part.value);
  const visualBody = asRecord(value?.visual);
  return {
    componentId: visual.id,
    title: readVisualTitle(value),
    visualType: typeof visualBody?.visualType === "string" ? visualBody.visualType : undefined,
    status,
    sections,
  };
}

function orderedVisuals(page: SidePage): SideVisual[] {
  return [...page.visuals.values()].sort((left, right) => {
    const leftPosition = asRecord(asRecord(left.part.value)?.position);
    const rightPosition = asRecord(asRecord(right.part.value)?.position);
    return numberValue(leftPosition?.tabOrder) - numberValue(rightPosition?.tabOrder) || left.id.localeCompare(right.id);
  });
}

function orderedVisualIds(primary: SidePage, secondary: SidePage): string[] {
  const ids = orderedVisuals(primary).map((item) => item.id);
  for (const item of orderedVisuals(secondary)) if (!ids.includes(item.id)) ids.push(item.id);
  return ids;
}

function diffPartMaps(before: Map<string, DecodedPart>, after: Map<string, DecodedPart>): ReportChange[] {
  const changes: ReportChange[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const partPath of paths) {
    const oldPart = before.get(partPath);
    const newPart = after.get(partPath);
    if (!oldPart) {
      changes.push({ kind: "added", path: partPath, after: "file added" });
      continue;
    }
    if (!newPart) {
      changes.push({ kind: "removed", path: partPath, before: "file removed" });
      continue;
    }
    if (!oldPart.isJson || !newPart.isJson) {
      if (!oldPart.bytes.equals(newPart.bytes)) {
        changes.push({ kind: "changed", path: partPath, before: `${oldPart.bytes.length} bytes`, after: `${newPart.bytes.length} bytes` });
      }
      continue;
    }
    const partChanges: ReportChange[] = [];
    diffValues(oldPart.value, newPart.value, "", partChanges);
    for (const change of partChanges) {
      changes.push({ ...change, path: change.path ? `${partPath}: ${change.path}` : partPath });
    }
  }
  return changes;
}

function diffDecodedParts(
  before: DecodedPart | undefined,
  after: DecodedPart | undefined,
  currentPath: string,
  changes: ReportChange[]
): void {
  if (!before && !after) return;
  if (!before) {
    changes.push({ kind: "added", path: currentPath || "value", after: "file added" });
    return;
  }
  if (!after) {
    changes.push({ kind: "removed", path: currentPath || "value", before: "file removed" });
    return;
  }
  if (!before.isJson || !after.isJson) {
    if (!before.bytes.equals(after.bytes)) {
      changes.push({
        kind: "changed",
        path: currentPath || "value",
        before: `${before.bytes.length} bytes (non-JSON)`,
        after: `${after.bytes.length} bytes (non-JSON)`,
      });
    }
    return;
  }
  diffValues(before.value, after.value, currentPath, changes);
}

function diffValues(before: unknown, after: unknown, currentPath: string, changes: ReportChange[]): void {
  if (canonical(before, false) === canonical(after, false)) return;
  if (before === undefined) {
    changes.push({ kind: "added", path: currentPath || "value", after });
    return;
  }
  if (after === undefined) {
    changes.push({ kind: "removed", path: currentPath || "value", before });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(before[index], after[index], `${currentPath}[${index}]`, changes);
    }
    return;
  }
  const beforeObject = asRecord(before);
  const afterObject = asRecord(after);
  if (beforeObject && afterObject) {
    for (const key of [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort()) {
      diffValues(beforeObject[key], afterObject[key], currentPath ? `${currentPath}.${key}` : key, changes);
    }
    return;
  }
  changes.push({ kind: "changed", path: currentPath || "value", before, after });
}

function groupChanges(changes: ReportChange[], scope: "report" | "page" | "component"): ReportDiffSection[] {
  const grouped = new Map<string, ReportChange[]>();
  for (const change of changes) {
    const section = categorize(change, scope);
    const list = grouped.get(section) ?? [];
    list.push(change);
    grouped.set(section, list);
  }
  return [...grouped.entries()]
    .map(([name, sectionChanges]) => ({ name, changes: sectionChanges }))
    .sort((left, right) => sectionRank(left.name) - sectionRank(right.name) || left.name.localeCompare(right.name));
}

function categorize(change: ReportChange, scope: "report" | "page" | "component"): string {
  const valueText = `${displayValue(change.before)} ${displayValue(change.after)}`.toLowerCase();
  const key = change.path.toLowerCase();
  if (/filter|slicer/.test(key)) return "Filters";
  if (/colou?r|fill|background|foreground|transparency|datacolors/.test(key) || /#[0-9a-f]{6,8}\b/.test(valueText)) return "Colours";
  if (/theme|registeredresources.*\.json/.test(key)) return "Themes";
  if (/datasetreference|semanticmodel|connectionstring|extensionmeasure/.test(key)) return "Model binding";
  if (/bookmark/.test(key)) return "Bookmarks";
  if (scope === "report" && /pages\.json|pageorder|activepagename/.test(key)) return "Pages";
  if (/position|\.x$|\.y$|\.z$|width|height|taborder|displayoption|canvas|mobile/.test(key)) return "Layout";
  if (/prototypequery|querystate|projection|query\b|column\b|measure\b|aggregation|sourceref|selects|binding/.test(key)) return "Bindings and data";
  if (/action|interaction|drill|visuallink|navigation|sync/.test(`${key} ${valueText}`)) return "Actions and interactions";
  if (/settings|config/.test(key) && scope === "report") return "Settings";
  if (/displayname|visibility|title.*text|visualtype|name$/.test(key)) return "Metadata";
  if (/objects|properties|format|font|label|legend|axis|border|shadow|padding|style/.test(key)) return "Formatting";
  if (/staticresources|resourcepackages|\.svg|\.png|\.jpg|\.jpeg|\.gif/.test(key)) return "Resources";
  return "Other";
}

function countPartStatuses(before: Map<string, DecodedPart>, after: Map<string, DecodedPart>): StatusCounts {
  const counts = emptyCounts();
  for (const partPath of new Set([...before.keys(), ...after.keys()])) {
    const oldPart = before.get(partPath);
    const newPart = after.get(partPath);
    if (!oldPart) counts.added += 1;
    else if (!newPart) counts.removed += 1;
    else if (canonicalPart(oldPart, false) === canonicalPart(newPart, false)) counts.unchanged += 1;
    else counts.changed += 1;
  }
  return counts;
}

function countStatuses(items: Array<{ status: DiffStatus }>): StatusCounts {
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function emptyCounts(): StatusCounts {
  return { added: 0, removed: 0, changed: 0, unchanged: 0 };
}

function mapsEqual<T>(
  before: Map<string, DecodedPart>,
  after: Map<string, DecodedPart>,
  select: (part: DecodedPart) => T
): boolean {
  if (before.size !== after.size) return false;
  for (const [partPath, oldPart] of before) {
    const newPart = after.get(partPath);
    if (!newPart) return false;
    const oldValue = select(oldPart);
    const newValue = select(newPart);
    if (Buffer.isBuffer(oldValue) && Buffer.isBuffer(newValue)) {
      if (!oldValue.equals(newValue)) return false;
    } else if (oldValue !== newValue) return false;
  }
  return true;
}

function canonical(value: unknown, ignoreSchema: boolean): string {
  return JSON.stringify(sortValue(ignoreSchema ? stripSchema(value) : value));
}

function canonicalPart(part: DecodedPart, ignoreSchema: boolean): string {
  return part.isJson ? canonical(part.value, ignoreSchema) : `binary:${part.bytes.toString("base64")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  const object = asRecord(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortValue(object[key])]));
}

function stripSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchema);
  const object = asRecord(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== "$schema").map(([key, child]) => [key, stripSchema(child)])
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pageName(page: SidePage): string {
  const value = asRecord(page.pagePart?.value);
  return typeof value?.displayName === "string" ? value.displayName : page.id;
}

function readVisualTitle(value: Record<string, unknown> | undefined): string | undefined {
  const visual = asRecord(value?.visual);
  const containers = asRecord(visual?.visualContainerObjects);
  const titles = containers?.title;
  if (!Array.isArray(titles)) return undefined;
  const first = asRecord(titles[0]);
  const properties = asRecord(first?.properties);
  const text = asRecord(properties?.text);
  const expr = asRecord(text?.expr);
  const literal = asRecord(expr?.Literal);
  const raw = literal?.Value;
  return typeof raw === "string" ? raw.replace(/^'(.*)'$/, "$1").replace(/''/g, "'") : undefined;
}

function orderedUnion(
  primary: string[],
  secondary: string[],
  before: Map<string, SidePage>,
  after: Map<string, SidePage>
): string[] {
  const ids: string[] = [];
  for (const id of [...primary, ...secondary, ...before.keys(), ...after.keys()]) {
    if ((before.has(id) || after.has(id)) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}

function sectionRank(name: string): number {
  const index = SECTION_ORDER.indexOf(name);
  return index < 0 ? SECTION_ORDER.length : index;
}

function formatReportDiff(
  diff: ReportDefinitionDiff,
  beforeLabel: string,
  afterLabel: string,
  includeUnchanged: boolean
): string {
  const lines = [
    "# Power BI Report Diff",
    "",
    `- Comparison: ${beforeLabel} -> ${afterLabel}`,
    `- Result: ${diff.identical ? "identical definitions" : diff.semanticMatch ? "schema-only differences" : "differences found"}`,
    `- Definition match: ${yesNo(diff.matches.definition)}`,
    `- Semantic match (ignoring $schema): ${yesNo(diff.matches.semantic)}`,
    `- Pages: ${formatCounts(diff.summary.pages)}`,
    `- Components: ${formatCounts(diff.summary.components)}`,
    "",
    "## Report",
  ];
  appendSections(lines, diff.report.sections, 3);
  lines.push("", "## Pages");
  if (!diff.pages.length) lines.push("- No page or component differences.");
  for (const page of diff.pages) {
    lines.push("", `### ${page.displayName} (${page.pageId}) - ${titleCase(page.status)}`);
    appendSections(lines, page.sections, 4);
    const listedComponents = includeUnchanged
      ? page.components
      : page.components.filter((component) => component.status !== "unchanged");
    if (listedComponents.length) lines.push("", "#### Components");
    for (const component of listedComponents) {
      const label = component.title ?? component.visualType ?? "Untitled component";
      const type = component.visualType ? `, ${component.visualType}` : "";
      lines.push("", `##### ${label} (${component.componentId}${type}) - ${titleCase(component.status)}`);
      for (const section of component.sections) {
        lines.push(`**${section.name}**`);
        appendChanges(lines, section.changes);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendSections(lines: string[], sections: ReportDiffSection[], headingLevel: number): void {
  if (!sections.length) {
    lines.push("- No direct differences.");
    return;
  }
  for (const section of sections) {
    lines.push("", `${"#".repeat(headingLevel)} ${section.name}`);
    appendChanges(lines, section.changes);
  }
}

function appendChanges(lines: string[], changes: ReportChange[]): void {
  for (const change of changes) {
    if (change.kind === "added") lines.push(`- Added \`${change.path}\`: ${displayValue(change.after)}`);
    else if (change.kind === "removed") lines.push(`- Removed \`${change.path}\`: ${displayValue(change.before)}`);
    else lines.push(`- Changed \`${change.path}\`: ${displayValue(change.before)} -> ${displayValue(change.after)}`);
  }
}

function displayValue(value: unknown): string {
  if (value === undefined) return "not set";
  const rendered = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  if (rendered === undefined) return String(value);
  return rendered.length > 180 ? `${rendered.slice(0, 177)}...` : rendered;
}

function formatCounts(counts: StatusCounts): string {
  return `${counts.added} added, ${counts.removed} removed, ${counts.changed} changed, ${counts.unchanged} unchanged`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function titleCase(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}
