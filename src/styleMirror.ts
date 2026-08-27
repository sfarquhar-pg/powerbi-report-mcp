/**
 * Style mirroring — extract a reusable style profile from any Power BI report
 * definition (PBIR parts) and apply it to the connected report.
 *
 * Given a report LINK, agents should mirror its look implicitly: parse the URL,
 * pull the source definition (permissions allowing), extract the profile
 * (theme, tabs, header/banner spec, logo/images, typography, per-visual-type
 * exemplars) and apply the transferable parts.
 */
import * as fs from "fs";
import * as path from "path";

export interface ParsedReportUrl {
  workspaceId: string | "me";
  reportId: string;
  pageId?: string;
}

export interface BannerElement {
  visualType: string;
  x: number; y: number; width: number; height: number;
  fill?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  imageResource?: string;
}

export interface StyleProfile {
  source: { workspaceId: string; reportId: string; pulledAt: string };
  access: "full" | "partial";
  gaps: string[];
  baseTheme?: string;
  customThemeName?: string;
  customTheme?: unknown;
  pageSize?: { width: number; height: number };
  tabs: Array<{ name: string; displayName: string; order: number; hidden?: boolean }>;
  activePage?: string;
  banner?: {
    height: number;
    elements: BannerElement[];
  };
  navTabs?: { present: boolean; visualTypes: string[] };
  typography: {
    fontFamilies: Record<string, number>;
    titleFontSizes: Record<string, number>;
    titleColors: Record<string, number>;
  };
  imageResources: Array<{ name: string; path: string; base64?: string }>;
  visualExemplars: Record<string, unknown>;
  /** Theme-ready visualStyles derived from exemplars (borders, backgrounds, title bars, per-type text). */
  visualStyleDefaults?: Record<string, unknown>;
}

const URL_PATTERNS = [
  /app\.powerbi\.com\/groups\/(me|[0-9a-f-]{36})\/reports\/([0-9a-f-]{36})(?:\/([A-Za-z0-9]+))?/i,
  /app\.powerbi\.com\/reports\/([0-9a-f-]{36})/i,
];

/** Parse any app.powerbi.com report link into workspace/report/page ids. */
export function parsePowerBiReportUrl(url: string): ParsedReportUrl | null {
  const grouped = URL_PATTERNS[0].exec(url);
  if (grouped) {
    const page = grouped[3] && !/^ReportSection/i.test(grouped[3]) && grouped[3].includes("?")
      ? undefined
      : grouped[3]?.split("?")[0];
    return { workspaceId: grouped[1].toLowerCase() === "me" ? "me" : grouped[1], reportId: grouped[2], pageId: page || undefined };
  }
  const bare = URL_PATTERNS[1].exec(url);
  if (bare) return { workspaceId: "me", reportId: bare[1] };
  return null;
}

type Part = { path: string; payload: string };

function decode(part: Part): string {
  return Buffer.from(part.payload, "base64").toString("utf8");
}

function tryJson<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** Read a literal-or-themed property expression value (PBIR expr wrapper). */
function literal(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  const v = value as Record<string, unknown>;
  const expr = (v.expr ?? v) as Record<string, unknown>;
  const lit = (expr.Literal as Record<string, unknown> | undefined)?.Value;
  if (typeof lit === "string") return lit.replace(/^'|'$/g, "").replace(/[LD]$/, "");
  const themeCol = (expr.ThemeDataColor ?? expr.SolidColor) as Record<string, unknown> | undefined;
  if (themeCol) return JSON.stringify(themeCol);
  const solid = ((v.solid as Record<string, unknown>)?.color) ?? undefined;
  if (solid !== undefined) return literal(solid);
  return undefined;
}

function firstObject(objects: unknown, name: string): Record<string, unknown> | undefined {
  const list = (objects as Record<string, unknown> | undefined)?.[name];
  if (!Array.isArray(list) || !list.length) return undefined;
  return (list[0] as Record<string, unknown>).properties as Record<string, unknown>;
}

/** Extract a transferable style profile from PBIR definition parts. */
export function extractStyleProfile(
  parts: Part[],
  source: { workspaceId: string; reportId: string }
): StyleProfile {
  const byPath = new Map(parts.map((p) => [p.path.replace(/\\/g, "/"), p]));
  // PBIR-Legacy reports ship a single root report.json with sections/visualContainers
  if (!byPath.has("definition/report.json") && byPath.has("report.json")) {
    return extractLegacyStyleProfile(byPath, source);
  }
  const profile: StyleProfile = {
    source: { ...source, pulledAt: new Date().toISOString() },
    access: "full",
    gaps: [],
    tabs: [],
    typography: { fontFamilies: {}, titleFontSizes: {}, titleColors: {} },
    imageResources: [],
    visualExemplars: {},
  };

  // theme
  const reportJson = byPath.has("definition/report.json")
    ? tryJson<Record<string, unknown>>(decode(byPath.get("definition/report.json")!))
    : null;
  const themeCollection = reportJson?.themeCollection as Record<string, Record<string, unknown>> | undefined;
  profile.baseTheme = themeCollection?.baseTheme?.name as string | undefined;
  const customName = themeCollection?.customTheme?.name as string | undefined;
  if (customName) {
    profile.customThemeName = customName;
    const themePart = [...byPath.keys()].find((p) => p.endsWith(`RegisteredResources/${customName}`));
    if (themePart) profile.customTheme = tryJson(decode(byPath.get(themePart)!));
    else profile.gaps.push(`custom theme resource '${customName}' not found in definition parts`);
  }

  // pages / tabs
  const pagesJson = byPath.has("definition/pages/pages.json")
    ? tryJson<{ pageOrder?: string[]; activePageName?: string }>(decode(byPath.get("definition/pages/pages.json")!))
    : null;
  const order = pagesJson?.pageOrder ?? [];
  profile.activePage = pagesJson?.activePageName;
  for (const [p, part] of byPath) {
    const m = /^definition\/pages\/([^/]+)\/page\.json$/.exec(p);
    if (!m) continue;
    const page = tryJson<Record<string, unknown>>(decode(part));
    if (!page) continue;
    profile.tabs.push({
      name: String(page.name ?? m[1]),
      displayName: String(page.displayName ?? m[1]),
      order: order.indexOf(String(page.name ?? m[1])),
      hidden: page.visibility === "HiddenInViewMode" || page.visibility === 1 ? true : undefined,
    });
    if (!profile.pageSize && typeof page.width === "number") {
      profile.pageSize = { width: page.width as number, height: page.height as number };
    }
  }
  profile.tabs.sort((a, b) => a.order - b.order);

  // visuals: banner detection, typography tally, exemplars, nav tabs
  const pageWidth = profile.pageSize?.width ?? 1280;
  const bannerElements: BannerElement[] = [];
  const navTypes = new Set<string>();
  for (const [p, part] of byPath) {
    const m = /^definition\/pages\/([^/]+)\/visuals\/([^/]+)\/visual\.json$/.exec(p);
    if (!m) continue;
    const visual = tryJson<Record<string, any>>(decode(part));
    if (!visual) continue;
    const vc = visual.visual ?? {};
    const type = String(vc.visualType ?? "unknown");
    const pos = visual.position ?? {};

    if (type === "pageNavigator" || type === "actionButton") navTypes.add(type);

    // typography from title objects
    const titleProps = firstObject(vc.objects, "title") ?? firstObject(vc.visualContainerObjects, "title");
    if (titleProps) {
      const family = literal(titleProps.fontFamily);
      const size = literal(titleProps.fontSize);
      const color = literal(titleProps.fontColor);
      if (family) profile.typography.fontFamilies[family] = (profile.typography.fontFamilies[family] ?? 0) + 1;
      if (size) profile.typography.titleFontSizes[size] = (profile.typography.titleFontSizes[size] ?? 0) + 1;
      if (color) profile.typography.titleColors[color] = (profile.typography.titleColors[color] ?? 0) + 1;
    }

    // banner: top band, wide
    if ((pos.y ?? 999) <= 8 && (pos.height ?? 999) <= 130 && (pos.width ?? 0) >= pageWidth * 0.5) {
      const fillProps = firstObject(vc.objects, "fill") ?? firstObject(vc.objects, "background") ?? firstObject(vc.visualContainerObjects, "background");
      const textRun = JSON.stringify(vc.objects?.text ?? vc.objects?.general ?? "");
      const textMatch = /"text"\s*:\s*(?:\{[^}]*"Value"\s*:\s*")?'?([^"'{}]{2,80})'?"/.exec(textRun);
      bannerElements.push({
        visualType: type,
        x: pos.x ?? 0, y: pos.y ?? 0, width: pos.width ?? 0, height: pos.height ?? 0,
        fill: literal(fillProps?.fillColor) ?? literal(fillProps?.color),
        text: textMatch?.[1],
        fontFamily: literal(titleProps?.fontFamily),
        fontSize: Number(literal(titleProps?.fontSize)) || undefined,
        fontColor: literal(titleProps?.fontColor),
        imageResource: type === "image" ? literal(firstObject(vc.objects, "imageScaling")?.imageUrl) ?? extractImageResource(vc) : undefined,
      });
    }

    // first exemplar per type (raw objects for detailed-setting mirroring)
    if (!profile.visualExemplars[type]) {
      profile.visualExemplars[type] = {
        position: pos,
        objects: vc.objects ?? {},
        visualContainerObjects: vc.visualContainerObjects ?? {},
      };
    }
  }
  if (bannerElements.length) {
    profile.banner = {
      height: Math.max(...bannerElements.map((b) => b.y + b.height)),
      elements: bannerElements.sort((a, b) => a.x - b.x),
    };
  }
  profile.navTabs = { present: navTypes.size > 0, visualTypes: [...navTypes] };

  // image resources (logos etc.)
  for (const [p, part] of byPath) {
    const m = /^StaticResources\/RegisteredResources\/(.+)$/.exec(p);
    if (!m) continue;
    if (m[1] === profile.customThemeName) continue;
    if (/\.(png|jpe?g|gif|svg)$/i.test(m[1])) {
      profile.imageResources.push({ name: m[1], path: p, base64: part.payload });
    }
  }

  profile.visualStyleDefaults = deriveVisualStyleDefaults(profile);
  return profile;
}

function extractImageResource(vc: Record<string, any>): string | undefined {
  const general = firstObject(vc.objects, "general") as Record<string, any> | undefined;
  const url = general?.imageUrl;
  const name = url?.expr?.ResourcePackageItem?.ItemName;
  return typeof name === "string" ? name : undefined;
}

/** PBIR-Legacy: one root report.json with config (JSON string or object), sections[], visualContainers[]. */
function extractLegacyStyleProfile(
  byPath: Map<string, Part>,
  source: { workspaceId: string; reportId: string }
): StyleProfile {
  const profile: StyleProfile = {
    source: { ...source, pulledAt: new Date().toISOString() },
    access: "full",
    gaps: ["source is PBIR-Legacy format — profile converted from sections/visualContainers"],
    tabs: [],
    typography: { fontFamilies: {}, titleFontSizes: {}, titleColors: {} },
    imageResources: [],
    visualExemplars: {},
  };
  const root = tryJson<Record<string, any>>(decode(byPath.get("report.json")!));
  if (!root) { profile.access = "partial"; profile.gaps.push("report.json unparsable"); return profile; }

  const config = typeof root.config === "string" ? tryJson<Record<string, any>>(root.config) ?? {} : root.config ?? {};
  profile.baseTheme = config.themeCollection?.baseTheme?.name;
  const customName = config.themeCollection?.customTheme?.name as string | undefined;
  if (customName) {
    profile.customThemeName = customName.endsWith(".json") ? customName : `${customName}.json`;
    const themePart = [...byPath.keys()].find((p) => p.includes("RegisteredResources/") && p.endsWith(customName));
    if (themePart) profile.customTheme = tryJson(decode(byPath.get(themePart)!));
  }

  const sections: Array<Record<string, any>> = root.sections ?? [];
  sections.forEach((s, i) => {
    profile.tabs.push({
      name: String(s.name ?? i),
      displayName: String(s.displayName ?? s.name ?? i),
      order: typeof s.ordinal === "number" ? s.ordinal : i,
      hidden: (typeof s.config === "string" ? tryJson<Record<string, any>>(s.config) : s.config)?.visibility === 1 ? true : undefined,
    });
    if (!profile.pageSize && typeof s.width === "number") profile.pageSize = { width: s.width, height: s.height };
  });
  profile.tabs.sort((a, b) => a.order - b.order);

  const pageWidth = profile.pageSize?.width ?? 1280;
  const bannerElements: BannerElement[] = [];
  const navTypes = new Set<string>();
  type LegacyVisual = { type: string; pos: Record<string, number>; sv: Record<string, any> };
  const allVisuals: LegacyVisual[] = [];
  for (const s of sections) {
    for (const vcRaw of s.visualContainers ?? []) {
      const cfg = typeof vcRaw.config === "string" ? tryJson<Record<string, any>>(vcRaw.config) : vcRaw.config;
      if (!cfg) continue;
      const sv = cfg.singleVisual ?? {};
      const type = String(sv.visualType ?? "unknown");
      const pos = (cfg.layouts ?? [])[0]?.position ?? { x: vcRaw.x, y: vcRaw.y, width: vcRaw.width, height: vcRaw.height };
      allVisuals.push({ type, pos, sv });
    }
  }
  // band = vertical extent of full-width shapes anchored at the top
  const bandShapes = allVisuals.filter((v) => v.type === "shape" && (v.pos?.y ?? 999) <= 8 && (v.pos?.width ?? 0) >= pageWidth * 0.5 && (v.pos?.height ?? 999) <= 130);
  const bandHeight = bandShapes.length ? Math.max(...bandShapes.map((v) => (v.pos.y ?? 0) + (v.pos.height ?? 0))) : 0;

  const legacyFirst = (objects: any, name: string) => {
    const list = objects?.[name];
    return Array.isArray(list) && list.length ? list[0].properties : undefined;
  };
  for (const { type, pos, sv } of allVisuals) {
    if (type === "pageNavigator" || type === "actionButton") navTypes.add(type);

    const titleProps = legacyFirst(sv.vcObjects, "title");
    if (titleProps) {
      const family = literal(titleProps.fontFamily);
      const size = literal(titleProps.fontSize);
      const color = literal(titleProps.fontColor);
      if (family) profile.typography.fontFamilies[family] = (profile.typography.fontFamilies[family] ?? 0) + 1;
      if (size) profile.typography.titleFontSizes[size] = (profile.typography.titleFontSizes[size] ?? 0) + 1;
      if (color) profile.typography.titleColors[color] = (profile.typography.titleColors[color] ?? 0) + 1;
    }
    const textRuns: Array<Record<string, any>> =
      legacyFirst(sv.objects, "general")?.paragraphs?.[0]?.textRuns ?? [];
    for (const run of textRuns) {
      const family = run.textStyle?.fontFamily;
      if (family) profile.typography.fontFamilies[family] = (profile.typography.fontFamilies[family] ?? 0) + 1;
    }

    const inBand = bandHeight > 0
      ? (pos?.y ?? 999) < bandHeight && (pos?.y ?? 0) + (pos?.height ?? 0) <= bandHeight * 1.6
      : (pos?.y ?? 999) <= 8 && (pos?.height ?? 999) <= 130 && (pos?.width ?? 0) >= pageWidth * 0.5;
    if (inBand) {
      const fillProps = legacyFirst(sv.objects, "fill") ?? legacyFirst(sv.vcObjects, "background");
      const imgName = legacyFirst(sv.objects, "general")?.imageUrl?.expr?.ResourcePackageItem?.ItemName;
      bannerElements.push({
        visualType: type,
        x: pos.x ?? 0, y: pos.y ?? 0, width: pos.width ?? 0, height: pos.height ?? 0,
        fill: literal(fillProps?.fillColor) ?? literal(fillProps?.color),
        text: textRuns[0]?.value && typeof textRuns[0].value === "string" ? textRuns[0].value : undefined,
        fontFamily: textRuns[0]?.textStyle?.fontFamily,
        fontSize: parseFloat(textRuns[0]?.textStyle?.fontSize) || undefined,
        fontColor: textRuns[0]?.textStyle?.color,
        imageResource: type === "image" && typeof imgName === "string" ? imgName : undefined,
      });
    }

    if (!profile.visualExemplars[type]) {
      profile.visualExemplars[type] = { position: pos, objects: sv.objects ?? {}, visualContainerObjects: sv.vcObjects ?? {} };
    }
  }
  if (bannerElements.length) {
    profile.banner = { height: Math.max(...bannerElements.map((b) => b.y + b.height)), elements: bannerElements.sort((a, b) => a.x - b.x) };
  }
  profile.navTabs = { present: navTypes.size > 0, visualTypes: [...navTypes] };

  for (const [p, part] of byPath) {
    const m = /RegisteredResources\/(.+)$/.exec(p);
    if (!m || m[1] === profile.customThemeName) continue;
    if (/\.(png|jpe?g|gif|svg)$/i.test(m[1])) profile.imageResources.push({ name: m[1], path: p, base64: part.payload });
  }
  profile.visualStyleDefaults = deriveVisualStyleDefaults(profile);
  return profile;
}

export interface ApplyResult {
  themeApplied: boolean;
  visualStylesMerged: boolean;
  imagesCopied: string[];
  bannerSpec?: StyleProfile["banner"];
  tabOrder: string[];
  notes: string[];
}

/** Unwrap a PBIR property expression into a plain theme value ('#324368', 3, true, "left"). */
function unwrap(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const v = value as Record<string, any>;
  const lit = (v.expr ?? v)?.Literal?.Value;
  if (typeof lit === "string") {
    if (/^'.*'$/.test(lit)) return lit.slice(1, -1);
    if (/^-?[\d.]+[DL]$/.test(lit)) return Number(lit.slice(0, -1));
    if (lit === "true" || lit === "false") return lit === "true";
    return lit;
  }
  const solid = v.solid?.color;
  if (solid !== undefined) {
    const inner = unwrap(solid);
    return typeof inner === "string" && inner.startsWith("#") ? { solid: { color: inner } } : undefined;
  }
  return undefined;
}

/** Convert one exemplar objects-block (expr-wrapped) into a theme visualStyles card list. */
function themeCards(objects: Record<string, any> | undefined, wanted: string[]): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const name of wanted) {
    const list = objects?.[name];
    if (!Array.isArray(list) || !list.length) continue;
    // only unselectored cards translate cleanly into a theme
    const first = list.find((entry: any) => !entry.selector) ?? list[0];
    const props: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(first.properties ?? {})) {
      const plain = unwrap(raw);
      if (plain !== undefined) props[key] = plain;
    }
    if (Object.keys(props).length) out[name] = [props];
  }
  return out;
}

/**
 * Derive theme-ready visualStyles from the profile's exemplars so container
 * chrome (borders, backgrounds, drop shadows, title bars, visual headers) and
 * per-type text settings (card labels, slicer header/items, table fonts) are
 * applied mechanically instead of being re-specified by hand — the class of
 * gap where a mirrored report "loses" borders and callout sizing.
 */
export function deriveVisualStyleDefaults(profile: StyleProfile): Record<string, unknown> {
  const CONTAINER = ["border", "background", "dropShadow", "visualHeader", "title"];
  const TYPE_OBJECTS: Record<string, string[]> = {
    card: ["labels", "categoryLabels"],
    slicer: ["items", "header"],
    pivotTable: ["values", "columnHeaders", "rowHeaders", "grid"],
    tableEx: ["values", "columnHeaders", "grid"],
    pageNavigator: ["shape", "outline", "text", "layout"],
  };
  const styles: Record<string, unknown> = {};
  let containerConsensus: Record<string, Array<Record<string, unknown>>> | null = null;

  for (const [type, exemplarRaw] of Object.entries(profile.visualExemplars ?? {})) {
    const exemplar = exemplarRaw as Record<string, any>;
    const container = themeCards(exemplar.visualContainerObjects, CONTAINER);
    const specific = themeCards(exemplar.objects, TYPE_OBJECTS[type] ?? []);
    const merged = { ...container, ...specific };
    if (Object.keys(merged).length) styles[type] = { "*": merged };
    if (!containerConsensus && container.border) containerConsensus = container;
  }
  // "*" fallback carries the shared container chrome (border/background) for
  // types without their own exemplar.
  if (containerConsensus) {
    const shared: Record<string, unknown> = {};
    for (const key of ["border", "background", "dropShadow"]) {
      if (containerConsensus[key]) shared[key] = containerConsensus[key];
    }
    if (Object.keys(shared).length) styles["*"] = { "*": shared };
  }
  return styles;
}

/**
 * Apply the transferable parts of a style profile to a connected report:
 * custom theme + image resources are written directly; banner/tab specs are
 * returned for the agent to replicate with pbir_add_visual / pbir_create_page.
 */
export function applyStyleProfile(
  project: {
    getReport(): any;
    saveReport(report: any): void;
    saveRegisteredResource(filename: string, data: unknown): void;
    registeredResourcesPath: string;
  },
  profile: StyleProfile,
  reportVersion: { visual: string; report: string; page: string }
): ApplyResult {
  const result: ApplyResult = { themeApplied: false, visualStylesMerged: false, imagesCopied: [], tabOrder: profile.tabs.map((t) => t.displayName), notes: [] };

  const styleDefaults = profile.visualStyleDefaults ?? deriveVisualStyleDefaults(profile);
  const hasStyleDefaults = Object.keys(styleDefaults).length > 0;
  // fall back to a minimal generated theme when the source has none, so derived
  // container chrome (borders, title bars, card labels...) still lands
  const themeName = profile.customThemeName ?? (hasStyleDefaults ? "MirroredStyle.json" : undefined);
  const themeBody: Record<string, any> | undefined = profile.customTheme
    ? JSON.parse(JSON.stringify(profile.customTheme))
    : (hasStyleDefaults ? { name: "MirroredStyle" } : undefined);

  if (themeBody && themeName) {
    if (hasStyleDefaults) {
      const existing = (themeBody.visualStyles ?? {}) as Record<string, any>;
      for (const [type, starLevel] of Object.entries(styleDefaults)) {
        existing[type] = existing[type] ?? {};
        const target = existing[type]["*"] ?? {};
        Object.assign(target, (starLevel as Record<string, any>)["*"]);
        existing[type]["*"] = target;
      }
      themeBody.visualStyles = existing;
      result.visualStylesMerged = true;
    }
    const report = project.getReport();
    if (!report.themeCollection) report.themeCollection = {};
    report.themeCollection.customTheme = {
      name: themeName,
      reportVersionAtImport: reportVersion,
      type: "RegisteredResources",
    };
    if (!Array.isArray(report.resourcePackages)) report.resourcePackages = [];
    let pkg = report.resourcePackages.find((p: any) => p.type === "RegisteredResources");
    if (!pkg) {
      pkg = { name: "RegisteredResources", type: "RegisteredResources", items: [] };
      report.resourcePackages.push(pkg);
    }
    pkg.items = pkg.items.filter((item: any) => item.type !== "CustomTheme");
    pkg.items.push({ name: themeName, path: themeName, type: "CustomTheme" });
    project.saveRegisteredResource(themeName, themeBody);
    project.saveReport(report);
    result.themeApplied = true;
  } else {
    result.notes.push("source has no custom theme — keep or set one with pbir_set_report_theme");
  }

  const fsMod = fs;
  const pathMod = path;
  for (const img of profile.imageResources) {
    if (!img.base64) continue;
    fsMod.mkdirSync(project.registeredResourcesPath, { recursive: true });
    fsMod.writeFileSync(pathMod.join(project.registeredResourcesPath, img.name), Buffer.from(img.base64, "base64"));
    result.imagesCopied.push(img.name);
  }

  if (profile.banner) {
    result.bannerSpec = profile.banner;
    result.notes.push("replicate bannerSpec elements per page with pbir_add_visual (shape/image/textbox at the same geometry)");
  }
  if (profile.navTabs?.present) {
    result.notes.push(`source uses in-page navigation (${profile.navTabs.visualTypes.join(", ")}) — add a pageNavigator visual under the banner`);
  }
  return result;
}
