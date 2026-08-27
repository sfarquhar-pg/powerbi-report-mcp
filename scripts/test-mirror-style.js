#!/usr/bin/env node
/**
 * Unit tests for src/styleMirror.ts — URL parser + style profile extraction.
 * Runs against the frozen evals/fixtures/sample.Report fixture (no network).
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { parsePowerBiReportUrl, extractStyleProfile, applyStyleProfile } = require("../dist/styleMirror.js");

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log("styleMirror tests");

// --- URL parser ---
check("parses groups/{ws}/reports/{id}/{page}?query", () => {
  const p = parsePowerBiReportUrl("https://app.powerbi.com/groups/00000000-0000-0000-0000-000000000000/reports/00000000-0000-0000-0000-000000000000/PageNavToken000000ab?experience=power-bi");
  assert.strictEqual(p.workspaceId, "00000000-0000-0000-0000-000000000000");
  assert.strictEqual(p.reportId, "00000000-0000-0000-0000-000000000000");
  assert.strictEqual(p.pageId, "PageNavToken000000ab");
});
check("parses groups/me links", () => {
  const p = parsePowerBiReportUrl("https://app.powerbi.com/groups/me/reports/00000000-0000-0000-0000-000000000000");
  assert.strictEqual(p.workspaceId, "me");
  assert.strictEqual(p.reportId, "00000000-0000-0000-0000-000000000000");
});
check("parses bare report links as me", () => {
  const p = parsePowerBiReportUrl("https://app.powerbi.com/reports/00000000-0000-0000-0000-000000000000");
  assert.strictEqual(p.workspaceId, "me");
});
check("rejects non-report links", () => {
  assert.strictEqual(parsePowerBiReportUrl("https://app.powerbi.com/groups/x/dashboards/y"), null);
});

// --- extraction against the frozen fixture ---
const fixture = path.join(__dirname, "..", "evals", "fixtures", "sample.Report");
function partsFromDir(root) {
  const parts = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else parts.push({ path: path.relative(root, fp).split(path.sep).join("/"), payload: fs.readFileSync(fp).toString("base64") });
    }
  };
  walk(root);
  return parts;
}
const parts = partsFromDir(fixture);
const profile = extractStyleProfile(parts, { workspaceId: "w", reportId: "r" });

check("finds fixture custom theme", () => {
  assert.strictEqual(profile.customThemeName, "EvalTheme0.json");
  assert.ok(profile.customTheme && Array.isArray(profile.customTheme.dataColors), "theme JSON with dataColors");
});
check("captures base theme", () => assert.strictEqual(profile.baseTheme, "CY26SU02"));
check("captures all tabs in order", () => {
  assert.strictEqual(profile.tabs.length, 3);
  assert.deepStrictEqual(profile.tabs.map((t) => t.order), [0, 1, 2]);
});
check("captures page size", () => {
  assert.strictEqual(profile.pageSize.width, 1280);
  assert.strictEqual(profile.pageSize.height, 720);
});
check("collects visual exemplars by type", () => {
  assert.ok(Object.keys(profile.visualExemplars).length >= 2, "at least two visual types");
});
check("access is full with no theme gaps", () => {
  assert.strictEqual(profile.access, "full");
  assert.ok(!profile.gaps.some((g) => g.includes("custom theme")), "no theme gap");
});

// --- apply to a scratch project ---
const os = require("os");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-style-"));
const scratchResources = path.join(scratch, "StaticResources", "RegisteredResources");
let savedReport = null;
const savedResources = {};
const fakeProject = {
  getReport: () => ({ themeCollection: {}, resourcePackages: [] }),
  saveReport: (r) => { savedReport = r; },
  saveRegisteredResource: (name, data) => { savedResources[name] = data; },
  registeredResourcesPath: scratchResources,
};
const applied = applyStyleProfile(fakeProject, profile, { visual: "2.7.0", report: "3.2.0", page: "2.3.0" });
check("apply sets custom theme", () => {
  assert.strictEqual(applied.themeApplied, true);
  assert.strictEqual(savedReport.themeCollection.customTheme.name, "EvalTheme0.json");
  assert.ok(savedResources["EvalTheme0.json"], "theme resource saved");
});
check("apply returns tab order", () => assert.strictEqual(applied.tabOrder.length, 3));

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);

// --- legacy format extraction ---
const legacyRoot = {
  config: JSON.stringify({ themeCollection: { baseTheme: { name: "CY24SU10", type: 2 } } }),
  sections: [
    {
      name: "s1", displayName: "Overview", ordinal: 0, width: 1280, height: 720,
      visualContainers: [
        { config: JSON.stringify({ layouts: [{ position: { x: 0, y: 0, width: 1280, height: 72 } }], singleVisual: { visualType: "shape", objects: { fill: [{ properties: { fillColor: { solid: { color: { expr: { Literal: { Value: "'#324368'" } } } } } } }] }, vcObjects: {} } }) },
        { config: JSON.stringify({ layouts: [{ position: { x: 111, y: 9, width: 256, height: 53 } }], singleVisual: { visualType: "textbox", objects: { general: [{ properties: { paragraphs: [{ textRuns: [{ value: "Overview", textStyle: { fontFamily: "DIN", fontSize: "28pt", color: "#ffffff" } }] }] } }] }, vcObjects: {} } }) },
        { config: JSON.stringify({ layouts: [{ position: { x: 533, y: 28, width: 730, height: 44 } }], singleVisual: { visualType: "pageNavigator", objects: {}, vcObjects: {} } }) },
      ],
    },
    { name: "s2", displayName: "Detail", ordinal: 1, width: 1280, height: 720, visualContainers: [] },
  ],
};
const legacyParts = [
  { path: "report.json", payload: Buffer.from(JSON.stringify(legacyRoot)).toString("base64") },
  { path: "StaticResources/RegisteredResources/Logo1.png", payload: Buffer.from([137, 80, 78, 71]).toString("base64") },
  { path: "definition.pbir", payload: Buffer.from("{}").toString("base64") },
];
const legacyProfile = extractStyleProfile(legacyParts, { workspaceId: "w", reportId: "r" });
check("legacy: detects format and tabs", () => {
  assert.ok(legacyProfile.gaps.some((g) => g.includes("PBIR-Legacy")), "legacy gap note");
  assert.deepStrictEqual(legacyProfile.tabs.map((t) => t.displayName), ["Overview", "Detail"]);
});
check("legacy: base theme + page size", () => {
  assert.strictEqual(legacyProfile.baseTheme, "CY24SU10");
  assert.strictEqual(legacyProfile.pageSize.width, 1280);
});
check("legacy: banner elements with fill + text + font", () => {
  assert.ok(legacyProfile.banner, "banner detected");
  const shape = legacyProfile.banner.elements.find((e) => e.visualType === "shape");
  assert.strictEqual(shape.fill, "#324368");
  const tb = legacyProfile.banner.elements.find((e) => e.visualType === "textbox");
  assert.strictEqual(tb.text, "Overview");
  assert.strictEqual(tb.fontFamily, "DIN");
});
check("legacy: nav tabs + image resources + exemplars", () => {
  assert.strictEqual(legacyProfile.navTabs.present, true);
  assert.deepStrictEqual(legacyProfile.imageResources.map((i) => i.name), ["Logo1.png"]);
  assert.ok(legacyProfile.visualExemplars.textbox, "textbox exemplar");
});
console.log("legacy assertions done");

// --- derived visual style defaults (0.10.2) ---
const { deriveVisualStyleDefaults } = require("../dist/styleMirror.js");
const legacyRoot2 = {
  config: JSON.stringify({ themeCollection: { baseTheme: { name: "CY24SU10", type: 2 } } }),
  sections: [{
    name: "s1", displayName: "P", ordinal: 0, width: 1280, height: 720,
    visualContainers: [
      { config: JSON.stringify({ layouts: [{ position: { x: 15, y: 200, width: 300, height: 80 } }], singleVisual: {
        visualType: "card",
        objects: { labels: [{ properties: { fontSize: { expr: { Literal: { Value: "11D" } } } } }], categoryLabels: [{ properties: { show: { expr: { Literal: { Value: "false" } } } } }] },
        vcObjects: { border: [{ properties: { show: { expr: { Literal: { Value: "true" } } }, color: { solid: { color: { expr: { Literal: { Value: "'#324368'" } } } } }, radius: { expr: { Literal: { Value: "3D" } } } } }], dropShadow: [{ properties: { show: { expr: { Literal: { Value: "false" } } } } }] },
      } }) },
      { config: JSON.stringify({ layouts: [{ position: { x: 15, y: 300, width: 300, height: 60 } }], singleVisual: {
        visualType: "slicer",
        objects: { header: [{ properties: { text: { expr: { Literal: { Value: "'Role'" } } }, textSize: { expr: { Literal: { Value: "11D" } } } } }], items: [{ properties: { fontFamily: { expr: { Literal: { Value: "'wf_standard-font'" } } } } }] },
        vcObjects: { border: [{ properties: { show: { expr: { Literal: { Value: "true" } } }, color: { solid: { color: { expr: { Literal: { Value: "'#324368'" } } } } } } }] },
      } }) },
    ],
  }],
};
const legacyParts2 = [{ path: "report.json", payload: Buffer.from(JSON.stringify(legacyRoot2)).toString("base64") }];
const p2 = extractStyleProfile(legacyParts2, { workspaceId: "w", reportId: "r" });
check("derive: profile carries visualStyleDefaults", () => {
  assert.ok(p2.visualStyleDefaults, "visualStyleDefaults present");
  assert.ok(p2.visualStyleDefaults.card, "card styles derived");
});
check("derive: card border + labels unwrapped to theme values", () => {
  const cardStar = p2.visualStyleDefaults.card["*"];
  assert.strictEqual(cardStar.border[0].show, true);
  assert.deepStrictEqual(cardStar.border[0].color, { solid: { color: "#324368" } });
  assert.strictEqual(cardStar.border[0].radius, 3);
  assert.strictEqual(cardStar.labels[0].fontSize, 11);
  assert.strictEqual(cardStar.categoryLabels[0].show, false);
});
check("derive: slicer header/items + shared '*' chrome", () => {
  const slicerStar = p2.visualStyleDefaults.slicer["*"];
  assert.strictEqual(slicerStar.header[0].text, "Role");
  assert.strictEqual(slicerStar.items[0].fontFamily, "wf_standard-font");
  assert.ok(p2.visualStyleDefaults["*"], "shared chrome derived");
  assert.strictEqual(p2.visualStyleDefaults["*"]["*"].border[0].show, true);
});
check("apply: merges derived styles into theme even without source custom theme", () => {
  let savedName = null, savedBody = null, savedRep = null;
  const proj = {
    getReport: () => ({ themeCollection: {}, resourcePackages: [] }),
    saveReport: (r) => { savedRep = r; },
    saveRegisteredResource: (n, d) => { savedName = n; savedBody = d; },
    registeredResourcesPath: scratchResources,
  };
  const applied2 = applyStyleProfile(proj, p2, { visual: "2.7.0", report: "3.2.0", page: "2.3.0" });
  assert.strictEqual(applied2.themeApplied, true);
  assert.strictEqual(applied2.visualStylesMerged, true);
  assert.ok(savedBody.visualStyles.card, "card styles in saved theme");
  assert.strictEqual(savedRep.themeCollection.customTheme.name, savedName);
});
console.log("derive assertions done");
