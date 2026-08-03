#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

const { collectReportDefinitionParts } = require("../dist/fabricApi.js");
const {
  getDefinitionParts,
  finalizeMaterializedDefinition,
  materializeDefinitionParts,
  readDefinitionParts,
  recoverInterruptedReportReplacement,
  recoverInterruptedReportReplacements,
  rollbackMaterializedDefinition,
  writeDefinitionSnapshot,
} = require("../dist/reportDefinition.js");
const { compareReportDefinitions } = require("../dist/reportDiff.js");

const failures = [];
function assert(value, message) {
  if (value) console.log("  PASS:", message);
  else { console.error("  FAIL:", message); failures.push(message); }
}

function mutateJson(parts, partPath, mutate) {
  return parts.map((part) => {
    if (part.path !== partPath) return { ...part };
    const value = JSON.parse(Buffer.from(part.payload, "base64").toString("utf8"));
    mutate(value);
    return { ...part, payload: Buffer.from(JSON.stringify(value), "utf8").toString("base64") };
  });
}

function sectionNames(entity) {
  return entity.sections.map((section) => section.name);
}

(() => {
  console.log("Report pull/diff regressions\n");
  const fixture = path.resolve(__dirname, "..", "evals", "fixtures", "sample.Report");
  const fixtureParts = collectReportDefinitionParts(fixture);
  const parts = fixtureParts.some((part) => part.path === "definition.pbir") ? fixtureParts : [
    ...fixtureParts,
    {
      path: "definition.pbir",
      payload: Buffer.from(JSON.stringify({ version: "4.0" }), "utf8").toString("base64"),
      payloadType: "InlineBase64",
    },
  ];

  const identical = compareReportDefinitions(parts, parts);
  assert(identical.identical && identical.semanticMatch, "identical definitions compare equal");
  assert(identical.summary.changeCount === 0 && identical.pages.length === 0, "unchanged hierarchy is omitted by default");

  const schemaOnly = mutateJson(parts, "definition/report.json", (report) => {
    report.$schema = report.$schema.replace("3.2.0", "99.0.0");
  });
  const schemaDiff = compareReportDefinitions(parts, schemaOnly);
  assert(!schemaDiff.identical && schemaDiff.semanticMatch, "$schema-only drift is distinguished from semantic drift");
  assert(schemaDiff.summary.changeCount === 1 && schemaDiff.summary.parts.changed === 1, "$schema-only drift appears in counts and hierarchy");
  assert(schemaDiff.markdown.includes("$schema"), "$schema-only drift is visible in Markdown");

  const binaryPath = "StaticResources/RegisteredResources/binary-resource.bin";
  const binaryBefore = [...parts, { path: binaryPath, payload: Buffer.from([0x80]).toString("base64"), payloadType: "InlineBase64" }];
  const binaryAfter = [...parts, { path: binaryPath, payload: Buffer.from([0x81]).toString("base64"), payloadType: "InlineBase64" }];
  const binaryDiff = compareReportDefinitions(binaryBefore, binaryAfter);
  assert(!binaryDiff.identical && binaryDiff.summary.parts.changed === 1, "distinct binary resources cannot compare equal after UTF-8 decoding");

  let changed = mutateJson(parts, "definition/report.json", (report) => {
    report.settings.exportDataMode = "None";
  });
  changed = mutateJson(changed, "definition/pages/00000000000000000001/page.json", (page) => {
    page.width = 1440;
    page.filterConfig.filters[0].type = "Advanced";
  });
  changed = mutateJson(changed, "definition/pages/00000000000000000001/visuals/00000000000000000004/visual.json", (visual) => {
    visual.position.x = 40;
    visual.visual.objects.labels[0].properties.color = { solid: { color: "#FF0000" } };
  });
  const changedDiff = compareReportDefinitions(parts, changed);
  const overview = changedDiff.pages.find((page) => page.pageId === "00000000000000000001");
  const card = overview?.components.find((component) => component.componentId === "00000000000000000004");
  assert(sectionNames(changedDiff.report).includes("Settings"), "report settings changes are grouped at the root");
  assert(sectionNames(overview).includes("Filters") && sectionNames(overview).includes("Layout"), "page changes separate filters and layout");
  assert(sectionNames(card).includes("Colours") && sectionNames(card).includes("Layout"), "component changes separate colours and layout");
  assert(changedDiff.markdown.includes("## Report") && changedDiff.markdown.includes("## Pages") && changedDiff.markdown.includes("#### Components"), "Markdown renders report, page, and component hierarchy");

  const withUnchanged = compareReportDefinitions(parts, parts, { includeUnchanged: true });
  assert(withUnchanged.markdown.includes("- Unchanged"), "includeUnchanged includes unchanged components in Markdown");

  const removed = parts.filter((part) => !part.path.includes("/00000000000000000005/visual.json"));
  const removedDiff = compareReportDefinitions(parts, removed);
  const removedComponent = removedDiff.pages.flatMap((page) => page.components).find((component) => component.componentId === "00000000000000000005");
  assert(removedComponent?.status === "removed", "removed components are reported explicitly");

  const staleOrder = mutateJson(parts, "definition/pages/pages.json", (pages) => {
    pages.pageOrder.push("missing-page-id");
  });
  const staleOrderDiff = compareReportDefinitions(parts, staleOrder);
  assert(staleOrderDiff.report.sections.some((section) => section.name === "Pages"), "stale page-order references are reported without crashing");

  const pagePath = "definition/pages/00000000000000000001/page.json";
  const malformedPage = parts.map((part) => part.path === pagePath
    ? { ...part, payload: Buffer.from([0x80]).toString("base64") }
    : part);
  const malformedPageDiff = compareReportDefinitions(parts, malformedPage);
  assert(malformedPageDiff.pages[0]?.status === "changed" && malformedPageDiff.summary.changeCount > 0, "malformed page payload changes remain visible");

  const visualPath = "definition/pages/00000000000000000001/visuals/00000000000000000004/visual.json";
  const malformedVisual = parts.map((part) => part.path === visualPath
    ? { ...part, payload: Buffer.from([0x80]).toString("base64") }
    : part);
  const malformedVisualDiff = compareReportDefinitions(parts, malformedVisual);
  assert(malformedVisualDiff.pages[0]?.components[0]?.status === "changed", "malformed visual payload changes remain visible");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pbir-report-diff-"));
  try {
    const reportPath = path.join(temp, "Pulled.Report");
    const materialized = materializeDefinitionParts(parts, reportPath);
    const roundTrip = collectReportDefinitionParts(reportPath);
    assert(materialized.fileCount === parts.length, "PBIR pull materializes every definition part");
    assert(compareReportDefinitions(parts, roundTrip).matches.raw, "PBIR materialization round-trips byte-for-byte");

    const snapshotPath = path.join(temp, "live.json");
    const definition = { definition: { format: "PBIR", parts } };
    const snapshot = writeDefinitionSnapshot(definition, snapshotPath, {
      workspaceId: "00000000-0000-0000-0000-000000000001",
      reportId: "00000000-0000-0000-0000-000000000002",
    });
    assert(snapshot.partCount === parts.length, "JSON pull writes a lossless definition snapshot");
    assert(compareReportDefinitions(parts, readDefinitionParts(snapshotPath)).matches.raw, "JSON snapshot is accepted as a diff source");
    assert(getDefinitionParts(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))).length === parts.length, "snapshot keeps the Fabric definition envelope");

    let overwriteRejected = false;
    try { materializeDefinitionParts(parts, reportPath); } catch (error) { overwriteRejected = /non-empty/.test(error.message); }
    assert(overwriteRejected, "PBIR pull refuses to overwrite a non-empty report");

    const oldMarker = path.join(reportPath, "old-marker.txt");
    fs.writeFileSync(oldMarker, "old report", "utf8");
    const replaced = materializeDefinitionParts(parts, reportPath, { overwrite: true });
    assert(replaced.fileCount === parts.length && !fs.existsSync(oldMarker), "confirmed overwrite replaces the complete existing report");
    assert(compareReportDefinitions(parts, collectReportDefinitionParts(reportPath)).matches.raw, "overwritten PBIR matches the pulled definition byte-for-byte");
    assert(finalizeMaterializedDefinition(replaced).backupRemoved, "successful overwrite removes its previous-report backup after validation");

    fs.writeFileSync(oldMarker, "restore me", "utf8");
    const originalRename = fs.renameSync;
    let renameCalls = 0;
    fs.renameSync = (...args) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("simulated install failure");
      return originalRename(...args);
    };
    let rollbackWorked = false;
    try {
      materializeDefinitionParts(parts, reportPath, { overwrite: true });
    } catch (error) {
      rollbackWorked = /simulated install failure/.test(error.message) &&
        fs.existsSync(oldMarker) && fs.readFileSync(oldMarker, "utf8") === "restore me";
    } finally {
      fs.renameSync = originalRename;
    }
    assert(rollbackWorked, "failed overwrite restores the original report automatically");

    const rollbackTransaction = materializeDefinitionParts(parts, reportPath, { overwrite: true });
    rollbackMaterializedDefinition(rollbackTransaction);
    assert(fs.existsSync(oldMarker), "post-install validation failure can roll back to the previous report");

    const interruptedBackup = path.join(temp, `.${path.basename(reportPath)}.pull-interrupted.previous`);
    fs.renameSync(reportPath, interruptedBackup);
    const recoveredFrom = recoverInterruptedReportReplacement(reportPath);
    assert(recoveredFrom === interruptedBackup && fs.existsSync(reportPath), "next pull can recover an interrupted replacement window");

    const parentRecoveryBackup = path.join(temp, `.${path.basename(reportPath)}.pull-parent.previous`);
    fs.renameSync(reportPath, parentRecoveryBackup);
    const parentRecovered = recoverInterruptedReportReplacements(temp);
    assert(parentRecovered.includes(parentRecoveryBackup) && fs.existsSync(reportPath), "parent .pbip folder connection recovers an interrupted child report replacement");

    const invalidJsonParts = parts.map((part) => part.path === "definition/report.json"
      ? { ...part, payload: Buffer.from("not json", "utf8").toString("base64") }
      : part);
    let invalidJsonRejected = false;
    try { materializeDefinitionParts(invalidJsonParts, reportPath, { overwrite: true }); }
    catch (error) { invalidJsonRejected = /invalid JSON/.test(error.message); }
    assert(invalidJsonRejected && fs.existsSync(reportPath), "invalid pulled JSON is rejected before replacing the current report");

    const malformedUtf8Parts = parts.map((part) => part.path === "definition/report.json"
      ? { ...part, payload: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]).toString("base64") }
      : part);
    let malformedUtf8Rejected = false;
    try { materializeDefinitionParts(malformedUtf8Parts, reportPath, { overwrite: true }); }
    catch (error) { malformedUtf8Rejected = /invalid JSON/.test(error.message); }
    assert(malformedUtf8Rejected && fs.existsSync(reportPath), "malformed UTF-8 JSON is rejected before replacing the current report");

    let traversalRejected = false;
    try {
      materializeDefinitionParts([
        { path: "../escape.json", payload: Buffer.from("{}").toString("base64"), payloadType: "InlineBase64" },
      ], path.join(temp, "Unsafe.Report"));
    } catch (error) { traversalRejected = /Unsafe definition part path/.test(error.message); }
    assert(traversalRejected && !fs.existsSync(path.join(temp, "escape.json")), "PBIR pull rejects path traversal");

    const duplicateSnapshot = path.join(temp, "duplicate.json");
    fs.writeFileSync(duplicateSnapshot, JSON.stringify({ definition: { parts: [
      { path: "definition.pbir", payload: Buffer.from("{}").toString("base64"), payloadType: "InlineBase64" },
      { path: "definition.pbir", payload: Buffer.from("{}").toString("base64"), payloadType: "InlineBase64" },
    ] } }), "utf8");
    let duplicateRejected = false;
    try { readDefinitionParts(duplicateSnapshot); } catch (error) { duplicateRejected = /duplicate path/.test(error.message); }
    assert(duplicateRejected, "snapshot diff rejects duplicate definition paths");

    let arbitraryDirectoryRejected = false;
    try { readDefinitionParts(temp); } catch (error) { arbitraryDirectoryRejected = /must end with .Report/.test(error.message); }
    assert(arbitraryDirectoryRejected, "diff source rejects arbitrary directories");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  if (failures.length) process.exit(1);
  console.log("\nOK: report pull/diff regressions passed.");
})();
