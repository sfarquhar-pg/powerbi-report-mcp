#!/usr/bin/env node
// Unit tests for src/styleAudit.ts
const assert = require("assert");
const { auditStyleConsistency } = require("../dist/styleAudit.js");
let passed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log("  ok -", name); } catch (e) { console.error("  FAIL -", name, e.message); process.exitCode = 1; } };
const lit = (v) => ({ expr: { Literal: { Value: typeof v === "string" ? `'${v}'` : typeof v === "number" ? `${v}D` : String(v) } } });

const visuals = [
  { pageId: "p1", visualId: "cardBad", json: { position: { height: 40 }, visual: { visualType: "card",
    objects: { labels: [{ properties: { fontSize: lit(24), fontFamily: lit("Comic Sans MS") } }], categoryLabels: [{ properties: { show: lit(false) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(true), fontSize: lit(11) } }], border: [{ properties: { show: lit(true) } }] } } } },
  { pageId: "p1", visualId: "cardOk", json: { position: { height: 90 }, visual: { visualType: "card",
    objects: { labels: [{ properties: { fontSize: lit(20), fontFamily: lit("DIN") } }], categoryLabels: [{ properties: { show: lit(false) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(true), fontSize: lit(11) } }], border: [{ properties: { show: lit(true) } }] } } } },
  { pageId: "p1", visualId: "slicerNoLabel", json: { position: { height: 48 }, visual: { visualType: "slicer",
    objects: { header: [{ properties: { show: lit(false) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(false) } }], border: [{ properties: { show: lit(true) } }] } } } },
  { pageId: "p1", visualId: "cardNoBorder", json: { position: { height: 90 }, visual: { visualType: "card",
    objects: { labels: [{ properties: { fontSize: lit(20), fontFamily: lit("DIN") } }], categoryLabels: [{ properties: { show: lit(false) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(true), fontSize: lit(11) } }], border: [{ properties: { show: lit(false) } }] } } } },
  { pageId: "p1", visualId: "cardBorder3", json: { position: { height: 90 }, visual: { visualType: "card",
    objects: { labels: [{ properties: { fontSize: lit(20), fontFamily: lit("DIN") } }], categoryLabels: [{ properties: { show: lit(false) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(true), fontSize: lit(11) } }], border: [{ properties: { show: lit(true) } }] } } } },
  { pageId: "p1", visualId: "badFilter", json: { position: { height: 300 }, visual: { visualType: "tableEx", objects: {}, visualContainerObjects: {} },
    filterConfig: { filters: [{ name: "g", field: { Measure: { Expression: { SourceRef: { Entity: "_Measures" } }, Property: "Gate" } }, type: "Advanced",
      filter: { Version: 2, From: [{ Name: "m", Entity: "WrongTable", Type: 0 }], Where: [{ Condition: { Comparison: { ComparisonKind: 1, Left: { Measure: { Expression: { SourceRef: { Source: "m" } }, Property: "Gate" } }, Right: { Literal: { Value: "0L" } } } } }] } }] } } },
];

const report = auditStyleConsistency(visuals, { fontAllowlist: ["DIN"] });
const codes = report.issues.map((i) => `${i.code}:${i.visualId}`);
check("flags card overflow", () => assert.ok(codes.includes("CARD_OVERFLOW:cardBad"), codes.join()));
check("passes fitting card", () => assert.ok(!codes.includes("CARD_OVERFLOW:cardOk")));
check("flags font violation", () => assert.ok(codes.includes("FONT_VIOLATION:cardBad")));
check("flags unlabeled slicer", () => assert.ok(codes.includes("UNLABELED_SLICER:slicerNoLabel")));
check("flags measure filter mismatch", () => assert.ok(codes.includes("MEASURE_FILTER_MISMATCH:badFilter")));
check("flags border minority", () => assert.ok(codes.includes("BORDER_INCONSISTENT:cardNoBorder")));
check("font census collected", () => assert.ok(report.fontCensus["DIN"] >= 3 && report.fontCensus["Comic Sans MS"] === 1));
check("clean subset passes", () => {
  const clean = auditStyleConsistency([visuals[1]], { fontAllowlist: ["DIN"] });
  assert.strictEqual(clean.ok, true);
});
console.log(`${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);

// placeholder auto-filters (no filter body) must not be flagged
const placeholder = [{ pageId: "p2", visualId: "auto", json: { position: { height: 300 }, visual: { visualType: "pivotTable", objects: {}, visualContainerObjects: {} },
  filterConfig: { filters: [{ name: "a", field: { Measure: { Expression: { SourceRef: { Entity: "_Measures" } }, Property: "X" } }, type: "Categorical" }] } } }];
check("placeholder auto-filters pass", () => {
  const rep = auditStyleConsistency(placeholder, {});
  assert.strictEqual(rep.issues.filter((i) => i.code === "MEASURE_FILTER_MISMATCH").length, 0);
});
console.log("placeholder assertion done");

// --- 0.12.0: component fit engine, textbox fit, typography drift ---
const { estimateMinSize, estimateTextBox } = require("../dist/styleAudit.js");
check("slicer dropdown min height ~62", () => {
  const est = estimateMinSize({ visual: { visualType: "slicer",
    objects: { data: [{ properties: { mode: lit("Dropdown") } }], header: [{ properties: { show: lit(true), textSize: lit(10) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(false) } }] } } });
  assert.ok(est.minHeight >= 58 && est.minHeight <= 66, `got ${est.minHeight}`);
});
check("undersized slicer flagged, exempt honored", () => {
  const sl = { pageId: "p", visualId: "s48", json: { position: { height: 48, width: 300 }, visual: { visualType: "slicer",
    objects: { data: [{ properties: { mode: lit("Dropdown") } }], header: [{ properties: { show: lit(true), text: lit("Survey"), textSize: lit(10) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(false) } }] } } } };
  const rep = auditStyleConsistency([sl], {});
  assert.ok(rep.issues.some((i) => i.code === "COMPONENT_UNDERSIZED"), "flagged");
  const rep2 = auditStyleConsistency([sl], { exempt: ["s48"] });
  assert.ok(!rep2.issues.some((i) => i.code === "COMPONENT_UNDERSIZED"), "exempted");
});
check("textbox overflow flagged (footer case: 10pt in 24px is fine, 44 chars in 200px is not)", () => {
  const tb = (w, h) => ({ pageId: "p", visualId: "tb", json: { position: { width: w, height: h }, visual: { visualType: "textbox",
    objects: { general: [{ properties: { paragraphs: [{ textRuns: [{ value: "PGS Campaign Analytics  -  PG Survey WIP Model", textStyle: { fontSize: "10pt" } }] }] } }] },
    visualContainerObjects: {} } } });
  const bad = auditStyleConsistency([tb(200, 34)], {});
  assert.ok(bad.issues.some((i) => i.code === "TEXT_OVERFLOW" && i.detail.includes("wraps")), "narrow box flagged via wrapped height");
  const good = auditStyleConsistency([tb(300, 34)], {});
  assert.ok(!good.issues.some((i) => i.code === "TEXT_OVERFLOW"), "wide passes");
});
check("typography drift flagged", () => {
  const cardAt = (id, size) => ({ pageId: "p", visualId: id, json: { position: { height: 90 }, visual: { visualType: "card",
    objects: { labels: [{ properties: { fontSize: lit(size), fontFamily: lit("Segoe UI") } }], categoryLabels: [{ properties: { show: lit(false) } }] },
    visualContainerObjects: { title: [{ properties: { show: lit(true), fontSize: lit(11) } }], border: [{ properties: { show: lit(true) } }] } } } });
  const rep = auditStyleConsistency([cardAt("a", 20), cardAt("b", 24)], {});
  assert.ok(rep.issues.some((i) => i.code === "TYPO_INCONSISTENT" && i.detail.includes("cardValue")), JSON.stringify(rep.issues));
  assert.ok(rep.typography.cardValue["20"] === 1 && rep.typography.cardValue["24"] === 1);
});
console.log("fit-engine assertions done");
