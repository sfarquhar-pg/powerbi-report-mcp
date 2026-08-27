/**
 * Style consistency auditor — deterministic gates for the styling regressions
 * that slip past layout validation:
 *   FONT_VIOLATION        — text properties using fonts outside the allowlist
 *   CARD_OVERFLOW         — card callout + title cannot fit the container (will scroll)
 *   UNLABELED_SLICER      — slicer with no visible label (title hidden/empty AND header hidden/empty)
 *   MEASURE_FILTER_MISMATCH — filterConfig measure filters whose From/Where don't reference the declared field
 *   BORDER_INCONSISTENT   — minority of a visual type explicitly deviating on border visibility
 * Returns issues plus a full font census for cohesion review.
 */

export interface StyleIssue {
  code: "FONT_VIOLATION" | "CARD_OVERFLOW" | "UNLABELED_SLICER" | "MEASURE_FILTER_MISMATCH" | "BORDER_INCONSISTENT"
    | "COMPONENT_UNDERSIZED" | "TEXT_OVERFLOW" | "TYPO_INCONSISTENT";
  pageId: string;
  visualId: string;
  visualType: string;
  detail: string;
}

export interface StyleAuditReport {
  ok: boolean;
  issues: StyleIssue[];
  fontCensus: Record<string, number>;
  typography: Record<string, Record<string, number>>;
  stats: { pages: number; visuals: number };
}

type VisualFile = {
  pageId: string;
  visualId: string;
  json: Record<string, any>;
};

const DECORATIVE = new Set(["shape", "textbox", "image", "actionButton", "pageNavigator"]);

function lit(value: unknown): string | number | boolean | undefined {
  if (value == null || typeof value !== "object") return value as never;
  const raw = (value as any)?.expr?.Literal?.Value ?? (value as any)?.Literal?.Value;
  if (typeof raw !== "string") return undefined;
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1);
  if (/^-?[\d.]+[DL]$/.test(raw)) return Number(raw.slice(0, -1));
  if (raw === "true" || raw === "false") return raw === "true";
  return raw;
}

function firstProps(objects: any, name: string): Record<string, any> | undefined {
  const list = objects?.[name];
  if (!Array.isArray(list) || !list.length) return undefined;
  return (list.find((e: any) => !e.selector) ?? list[0])?.properties;
}

function collectFonts(node: unknown, out: Record<string, number>): void {
  if (node == null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === "fontFamily" || key === "fontFace") && value != null) {
      const plain = typeof value === "string" ? value : lit(value);
      if (typeof plain === "string" && plain.length) out[plain] = (out[plain] ?? 0) + 1;
    } else {
      collectFonts(value, out);
    }
  }
}

const CHART_TYPES = new Set([
  "barChart", "clusteredBarChart", "columnChart", "clusteredColumnChart",
  "hundredPercentStackedBarChart", "hundredPercentStackedColumnChart",
  "lineChart", "areaChart", "stackedAreaChart", "hundredPercentStackedAreaChart",
  "lineClusteredColumnComboChart", "lineStackedColumnComboChart",
  "pieChart", "donutChart", "funnelChart", "treemap", "scatterChart", "ribbonChart", "waterfallChart",
]);

/**
 * Minimum-size estimate for a component so its content renders without
 * clipping/scrolling. Returns undefined when no rule applies.
 * Heuristics (px): text line height = fontSize * 1.8; avg char width = fontSize * 0.58;
 * dropdown input = 30; chrome/padding = 12-16; min chart plot = 120x160.
 */
export function estimateMinSize(json: Record<string, any>): { minHeight?: number; minWidth?: number; reason?: string } {
  const v = json.visual ?? {};
  const type = String(v.visualType ?? "unknown");
  const titleProps = firstProps(v.visualContainerObjects, "title");
  const titleShown = titleProps !== undefined && lit(titleProps?.show) !== false;
  const titleSize = Number(lit(titleProps?.fontSize) ?? 12);
  const titleBar = titleShown ? titleSize * 1.8 + 4 : 0;

  if (type === "slicer") {
    const header = firstProps(v.objects, "header");
    const headerShown = lit(header?.show) !== false;
    const headerSize = Number(lit(header?.textSize) ?? 10);
    const mode = String(lit(firstProps(v.objects, "data")?.mode) ?? "Basic");
    const input = mode === "Dropdown" ? 30 : Number(lit(firstProps(v.objects, "items")?.textSize) ?? 10) * 1.9 * 3;
    return { minHeight: titleBar + (headerShown ? headerSize * 1.8 : 0) + input + 14, minWidth: 120, reason: `slicer(${mode}): titleBar ${Math.round(titleBar)} + header ${headerShown ? Math.round(headerSize * 1.8) : 0} + input ${Math.round(input)} + padding 14` };
  }
  if (type === "listSlicer") {
    const itemSize = Number(lit(firstProps(v.objects, "items")?.textSize) ?? 10);
    return { minHeight: titleBar + itemSize * 1.9 * 3 + 14, minWidth: 120, reason: "listSlicer: 3 visible items minimum" };
  }
  if (type === "card") {
    const callout = Number(lit(firstProps(v.objects, "labels")?.fontSize) ?? 45);
    const category = lit(firstProps(v.objects, "categoryLabels")?.show) !== false ? 14 : 0;
    return { minHeight: titleBar + callout * 1.9 + category + 12, minWidth: callout * 3, reason: `card: titleBar ${Math.round(titleBar)} + callout ${callout}*1.9 + category ${category} + padding 12` };
  }
  if (CHART_TYPES.has(type)) {
    const legendShown = lit(firstProps(v.objects, "legend")?.show) !== false && firstProps(v.objects, "legend") !== undefined;
    return { minHeight: titleBar + (legendShown ? 22 : 0) + 120, minWidth: 180, reason: "chart: titleBar + legend + 120px plot minimum" };
  }
  if (type === "pivotTable" || type === "tableEx") {
    const valueSize = Number(lit(firstProps(v.objects, "values")?.fontSize) ?? 10);
    return { minHeight: titleBar + valueSize * 2 + valueSize * 2.2 * 2 + 12, minWidth: 150, reason: "table: titleBar + header + 2 data rows" };
  }
  if (type === "pageNavigator") {
    const textSize = Number(lit(firstProps(v.objects, "text")?.fontSize) ?? 10);
    return { minHeight: textSize * 2.6, minWidth: 200, reason: "pageNavigator: tab text height" };
  }
  return {};
}

/** Estimate the pixel box a text run needs. */
export function estimateTextBox(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split(/\n/);
  const maxChars = Math.max(...lines.map((l) => l.length), 1);
  return { width: Math.ceil(maxChars * fontSize * 0.58) + 16, height: Math.ceil(lines.length * fontSize * 1.8) + 10 };
}

function textboxContent(v: Record<string, any>): { text: string; fontSize: number } | undefined {
  const paragraphs = firstProps(v.objects, "general")?.paragraphs;
  if (!Array.isArray(paragraphs) || !paragraphs.length) return undefined;
  let text = "";
  let fontSize = 0;
  for (const p of paragraphs) {
    const runs = p.textRuns ?? [];
    text += runs.map((r: any) => (typeof r.value === "string" ? r.value : "")).join("");
    for (const r of runs) {
      const fs = parseFloat(String(r.textStyle?.fontSize ?? ""));
      if (fs) fontSize = Math.max(fontSize, fs);
    }
    text += "\n";
  }
  return { text: text.trimEnd(), fontSize: fontSize || 12 };
}

export function auditStyleConsistency(
  visuals: VisualFile[],
  options: { fontAllowlist?: string[]; exempt?: string[] } = {}
): StyleAuditReport {
  const issues: StyleIssue[] = [];
  const fontCensus: Record<string, number> = {};
  const typography: Record<string, Record<string, number>> = {};
  const exempt = new Set(options.exempt ?? []);
  const roleSize = (role: string, size: unknown) => {
    const n = Number(size);
    if (!n) return;
    typography[role] = typography[role] ?? {};
    typography[role][String(n)] = (typography[role][String(n)] ?? 0) + 1;
  };
  const pages = new Set<string>();

  for (const { pageId, visualId, json } of visuals) {
    pages.add(pageId);
    const v = json.visual ?? {};
    const type = String(v.visualType ?? "unknown");
    const pos = json.position ?? {};

    // font census + allowlist
    const localFonts: Record<string, number> = {};
    collectFonts(json, localFonts);
    for (const [font, n] of Object.entries(localFonts)) {
      fontCensus[font] = (fontCensus[font] ?? 0) + n;
      if (options.fontAllowlist?.length) {
        const allowed = options.fontAllowlist.some((a) => font.toLowerCase().includes(a.toLowerCase()));
        if (!allowed) {
          issues.push({ code: "FONT_VIOLATION", pageId, visualId, visualType: type, detail: `font '${font}' not in allowlist` });
        }
      }
    }

    // card overflow: title bar (~1.8x) + callout (~1.9x) + chrome must fit height
    if (type === "card") {
      const titleProps = firstProps(v.visualContainerObjects, "title");
      const titleShown = lit(titleProps?.show) !== false && titleProps !== undefined;
      const titleSize = Number(lit(titleProps?.fontSize) ?? 12);
      const calloutSize = Number(lit(firstProps(v.objects, "labels")?.fontSize) ?? 45);
      const categoryShown = lit(firstProps(v.objects, "categoryLabels")?.show) !== false;
      const needed = (titleShown ? titleSize * 1.8 : 0) + calloutSize * 1.9 + (categoryShown ? 14 : 0) + 12;
      if (pos.height && needed > pos.height) {
        issues.push({
          code: "CARD_OVERFLOW", pageId, visualId, visualType: type,
          detail: `needs ~${Math.round(needed)}px (title ${titleShown ? titleSize : 0} + callout ${calloutSize}) but container is ${Math.round(pos.height)}px — value will clip/scroll`,
        });
      }
    }

    // component minimum-size (skip exempted visuals — "scrollable unless asked")
    if (!exempt.has(visualId) && type !== "card") {
      const est = estimateMinSize(json);
      if (est.minHeight && pos.height && pos.height < est.minHeight - 1) {
        issues.push({ code: "COMPONENT_UNDERSIZED", pageId, visualId, visualType: type, detail: `height ${Math.round(pos.height)}px < required ~${Math.round(est.minHeight)}px (${est.reason}) — content will clip/scroll` });
      }
      if (est.minWidth && pos.width && pos.width < est.minWidth) {
        issues.push({ code: "COMPONENT_UNDERSIZED", pageId, visualId, visualType: type, detail: `width ${Math.round(pos.width)}px < required ~${est.minWidth}px (${est.reason})` });
      }
    }

    // textbox / shape-with-text content fit — wrap-aware: width overflow becomes
    // wrapped-line height demand; only flag when the wrapped text cannot fit the height.
    if ((type === "textbox" || type === "shape") && !exempt.has(visualId)) {
      const content = textboxContent(v);
      if (content && content.text.length && pos.width && pos.height) {
        const usable = Math.max(pos.width - 16, content.fontSize * 2);
        let wrappedLines = 0;
        for (const line of content.text.split("\n")) {
          wrappedLines += Math.max(1, Math.ceil((line.length * content.fontSize * 0.58) / usable));
        }
        const needH = wrappedLines * content.fontSize * 1.8 + 10;
        if (needH > pos.height + 1) {
          issues.push({ code: "TEXT_OVERFLOW", pageId, visualId, visualType: type, detail: `text wraps to ${wrappedLines} line(s) @${content.fontSize}pt needing ~${Math.round(needH)}px but box is ${Math.round(pos.height)}px — size the box for the font` });
        }
      }
    }

    // typography role census
    {
      const t = firstProps(v.visualContainerObjects, "title");
      if (t && lit(t.show) !== false) roleSize("visualTitle", lit(t.fontSize) ?? 12);
      if (type === "card") roleSize("cardValue", lit(firstProps(v.objects, "labels")?.fontSize));
      if (CHART_TYPES.has(type)) {
        roleSize("dataLabels", lit(firstProps(v.objects, "labels")?.fontSize));
        roleSize("legend", lit(firstProps(v.objects, "legend")?.fontSize));
        roleSize("axis", lit(firstProps(v.objects, "categoryAxis")?.fontSize));
      }
      if (type === "slicer" || type === "listSlicer") {
        roleSize("slicerHeader", lit(firstProps(v.objects, "header")?.textSize));
        roleSize("slicerItems", lit(firstProps(v.objects, "items")?.textSize));
      }
      if (type === "pivotTable" || type === "tableEx") {
        roleSize("tableValues", lit(firstProps(v.objects, "values")?.fontSize));
        roleSize("tableHeaders", lit(firstProps(v.objects, "columnHeaders")?.fontSize));
      }
    }

    // unlabeled slicer
    if (type === "slicer" || type === "listSlicer") {
      const titleProps = firstProps(v.visualContainerObjects, "title");
      const titleVisible = lit(titleProps?.show) !== false && String(lit(titleProps?.text) ?? "").length > 0;
      const headerProps = firstProps(v.objects, "header");
      const headerVisible = lit(headerProps?.show) !== false && String(lit(headerProps?.text) ?? "").length > 0;
      if (!titleVisible && !headerVisible) {
        issues.push({ code: "UNLABELED_SLICER", pageId, visualId, visualType: type, detail: "no visible label: container title hidden/empty and slicer header hidden/empty" });
      }
    }

    // measure-filter shape
    for (const f of json.filterConfig?.filters ?? []) {
      const fieldMeasure = f.field?.Measure;
      if (!fieldMeasure) continue;
      // bare placeholder filters (no filter body / no condition) are valid auto-filters
      if (!f.filter?.Where?.length) continue;
      const entity = fieldMeasure.Expression?.SourceRef?.Entity;
      const property = fieldMeasure.Property;
      const from = f.filter?.From?.[0];
      const whereLeft = f.filter?.Where?.[0]?.Condition?.Comparison?.Left?.Measure
        ?? f.filter?.Where?.[0]?.Condition?.In?.Expressions?.[0]?.Measure;
      const fromOk = from?.Entity === entity;
      const whereOk = whereLeft?.Property === property && whereLeft?.Expression?.SourceRef?.Source === from?.Name;
      if (!fromOk || !whereOk) {
        issues.push({
          code: "MEASURE_FILTER_MISMATCH", pageId, visualId, visualType: type,
          detail: `filter '${f.name}': From/Where do not align with field ${entity}[${property}] (fromOk=${fromOk}, whereOk=${whereOk}) — visual will fail to load`,
        });
      }
    }
  }

  // border consistency per data-visual type
  const byType = new Map<string, Array<{ pageId: string; visualId: string; border: boolean | undefined }>>();
  for (const { pageId, visualId, json } of visuals) {
    const type = String(json.visual?.visualType ?? "unknown");
    if (DECORATIVE.has(type)) continue;
    const border = lit(firstProps(json.visual?.visualContainerObjects, "border")?.show) as boolean | undefined;
    const list = byType.get(type) ?? [];
    list.push({ pageId, visualId, border });
    byType.set(type, list);
  }
  for (const [type, list] of byType) {
    const explicit = list.filter((e) => e.border !== undefined);
    if (explicit.length < 2) continue;
    const shown = explicit.filter((e) => e.border === true);
    const hidden = explicit.filter((e) => e.border === false);
    const [majority, minority] = shown.length >= hidden.length ? [shown, hidden] : [hidden, shown];
    if (minority.length && majority.length / explicit.length >= 0.7) {
      for (const e of minority) {
        issues.push({
          code: "BORDER_INCONSISTENT", pageId: e.pageId, visualId: e.visualId, visualType: type,
          detail: `border=${e.border} while ${majority.length}/${explicit.length} ${type} visuals use border=${majority[0].border}`,
        });
      }
    }
  }

  // typography consistency: any role rendered at >1 size is drift
  for (const [role, sizes] of Object.entries(typography)) {
    const entries = Object.entries(sizes);
    if (entries.length > 1) {
      const majority = entries.sort((a, b) => b[1] - a[1])[0];
      issues.push({
        code: "TYPO_INCONSISTENT", pageId: "-", visualId: "-", visualType: role,
        detail: `role '${role}' uses ${entries.length} sizes (${entries.map(([s2, n]) => `${s2}pt×${n}`).join(", ")}) — align to ${majority[0]}pt`,
      });
    }
  }

  return { ok: issues.length === 0, issues, fontCensus, typography, stats: { pages: pages.size, visuals: visuals.length } };
}
