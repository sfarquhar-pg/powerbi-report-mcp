#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FabricAuthManager } = require("../dist/fabricAuth.js");
const { FabricApiClient, collectReportDefinitionParts } = require("../dist/fabricApi.js");
const { auditFabricPermissions, reviewLiveReportErrors, extractReportReferences } = require("../dist/fabricAudit.js");
const { getDefinitionParts } = require("../dist/reportDefinition.js");

const failures = [];
function assert(value, message) {
  if (value) console.log("  PASS:", message);
  else { console.error("  FAIL:", message); failures.push(message); }
}

(async () => {
  console.log("Fabric auth/API safety regressions\n");
  const now = Date.now();
  let authenticateCalls = 0;
  let getTokenCalls = 0;
  const secretTokens = {
    "https://api.fabric.microsoft.com/.default": "FABRIC_SECRET_TOKEN",
    "https://analysis.windows.net/powerbi/api/.default": "POWERBI_SECRET_TOKEN",
  };
  const credential = {
    authenticate: async () => {
      authenticateCalls += 1;
      return {
        authority: "https://login.microsoftonline.com/common",
        homeAccountId: "home-account",
        clientId: "client-id",
        tenantId: "tenant-id",
        username: "user@example.test",
      };
    },
    getToken: async (scope) => {
      getTokenCalls += 1;
      return { token: secretTokens[scope], expiresOnTimestamp: now + 3_600_000 };
    },
  };
  const auth = new FabricAuthManager({ cacheMode: "memory", credentialFactory: () => credential });

  const statusBefore = auth.getStatus();
  assert(statusBefore.authenticated === false, "status is unauthenticated before explicit login");
  assert(authenticateCalls === 0, "status does not trigger interactive authentication");

  const login = await auth.login();
  assert(login.authenticated === true, "explicit login creates a usable Fabric + Power BI session");
  assert(authenticateCalls === 2, "explicit login authorizes both Fabric and Power BI resources");
  assert(login.tokenExposed === false, "login declares that no token was exposed");
  assert(!JSON.stringify(login).includes("SECRET_TOKEN"), "login response contains no bearer token material");

  const tokenCallsAfterLogin = getTokenCalls;
  assert(await auth.getToken("fabric") === "FABRIC_SECRET_TOKEN", "private token accessor returns cached Fabric token internally");
  assert(getTokenCalls === tokenCallsAfterLogin, "subsequent action reuses the cached token without new auth call");

  const logout = auth.signOut();
  assert(logout.authenticated === false, "logout clears the process session");
  let required = false;
  try { await auth.getToken("fabric"); } catch (error) { required = error.name === "FabricAuthenticationRequiredError"; }
  assert(required, "remote access after logout requires explicit login again");

  await auth.login();
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/folders")) {
      return new Response(JSON.stringify({ value: [{ id: "folder-uuid", displayName: "Test", workspaceId: "workspace" }] }), { status: 200 });
    }
    if (String(url).includes("/metadata/folders/")) {
      return new Response(JSON.stringify({ subfolders: [{ id: 12345, displayName: "Example Folder", objectId: "folder-uuid" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const api = new FabricApiClient(auth, fetcher);
  const byName = await api.resolveFolder("workspace", "Test");
  const byLegacy = await api.resolveFolder("workspace", "12345");
  assert(byName.id === "folder-uuid", "folder resolver accepts exact display name");
  assert(byLegacy.id === "folder-uuid" && byLegacy.legacyId === 12345, "folder resolver maps legacy numeric subfolderId to UUID");
  assert(requests.every((request) => String(request.init.headers.Authorization).startsWith("Bearer ")), "Fabric requests use private authorization headers");

  const customRequests = [];
  const customApi = new FabricApiClient(auth, async (url) => {
    customRequests.push(String(url));
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  }, { fabricApiBase: "https://fabric.example.invalid/v1/", powerBiApiBase: "https://powerbi.example.invalid/" });
  await customApi.listReports("workspace");
  assert(customRequests[0].startsWith("https://fabric.example.invalid/v1/"), "service base URLs are environment-configurable and trailing-slash safe");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pbir-parts-"));
  fs.mkdirSync(path.join(temp, "definition"));
  fs.writeFileSync(path.join(temp, "definition.pbir"), "{}", "utf8");
  fs.writeFileSync(path.join(temp, "definition", "report.json"), "{}", "utf8");
  const parts = collectReportDefinitionParts(temp);
  assert(parts.length === 2 && parts.every((part) => part.payloadType === "InlineBase64"), "report publisher packages PBIR files as inline base64 parts");
  assert(getDefinitionParts({ definition: { parts } }).length === 2, "pull decoder reads Fabric definition envelopes");
  fs.rmSync(temp, { recursive: true, force: true });

  const fabricToolsSource = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "fabric.ts"), "utf8");
  assert(fabricToolsSource.includes("confirmationRequired: true"), "remote publishing has an explicit confirmation gate");
  assert(fabricToolsSource.includes("Refusing to overwrite non-empty directory"), "project creation refuses to overwrite existing content");
  assert(!fabricToolsSource.includes("structuredContent: token"), "Fabric tools do not place tokens in structured responses");

  const zeroId = "00000000-0000-0000-0000-000000000000";
  const permissionApi = {
    probe: async (operation) => {
      try { return { ok: true, value: await operation() }; }
      catch (error) { return { ok: false, status: error.status, error: error.message }; }
    },
    getPowerBiWorkspace: async () => ({ id: zeroId, name: "Example Workspace" }),
    getPowerBiReport: async () => ({ id: zeroId, name: "Example Report", datasetId: zeroId, isOwnedByMe: true }),
    getReportDefinition: async () => ({ definition: { parts: [] } }),
    getPowerBiDataset: async () => ({ id: zeroId, name: "Example Model" }),
    executeDatasetQuery: async () => ({ results: [] }),
    getSemanticModelDefinition: async () => ({ definition: { parts: [] } }),
    listPowerBiDatasetUsers: async () => { const error = new Error("Fabric API 403: ACL enumeration denied"); error.status = 403; throw error; },
    listPowerBiWorkspaceUsers: async () => [{ identifier: "user@example.test", groupUserAccessRight: "Contributor" }],
  };
  const accessAudit = await auditFabricPermissions(permissionApi, {
    account: "user@example.test", workspaceId: zeroId, reportId: zeroId,
  });
  assert(accessAudit.profiles.builder === "ready", "permission audit verifies semantic-model Build through a capability probe");
  assert(accessAudit.profiles.reportEditor === "ready", "permission audit verifies report editing through definition access");
  assert(accessAudit.profiles.publisher === "ready", "permission audit reports Contributor publishing baseline as ready");
  assert(accessAudit.checks.find((check) => check.id === "semanticModel.directAccess").status === "unknown", "ACL enumeration failure stays unknown rather than becoming a false permission denial");

  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const textEncode = (value) => Buffer.from(value, "utf8").toString("base64");
  const reportParts = [
    { path: "definition/pages/page1/page.json", payload: encode({ displayName: "Overview" }), payloadType: "InlineBase64" },
    { path: "definition/pages/page1/visuals/visual1/visual.json", payload: encode({
      name: "visual1",
      visual: { visualType: "card", query: { queryState: { Values: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "ExampleTable" } }, Property: "ExampleField" } } }] } } } },
    }), payloadType: "InlineBase64" },
  ];
  const references = extractReportReferences(reportParts);
  assert(references.length === 1 && references[0].table === "ExampleTable", "live error review extracts visual field references from PBIR parts");

  const reviewApi = {
    getPowerBiReport: async () => ({ datasetId: zeroId }),
    getReportDefinition: async () => ({ definition: { parts: reportParts } }),
    getSemanticModelDefinition: async () => ({ definition: { parts: [{ path: "definition/tables/ExampleTable.tmdl", payload: textEncode("table ExampleTable\n\tcolumn ExampleField\n\t\tdataType: string"), payloadType: "InlineBase64" }] } }),
    probe: async (operation) => {
      try { return { ok: true, value: await operation() }; }
      catch (error) { return { ok: false, status: 400, error: error.message }; }
    },
    executeDatasetQuery: async (_workspace, _model, query) => {
      if (query.includes("__pbir_permission_check")) return { results: [] };
      const error = new Error("Fabric API 400: Cannot find table 'ExampleTable'.");
      throw error;
    },
  };
  const liveReview = await reviewLiveReportErrors(reviewApi, { workspaceId: zeroId, reportId: zeroId });
  assert(liveReview.issues[0].code === "execute_queries_probe_inconclusive", "live review treats a REST/TMDL disagreement as inconclusive when the model definition contains the table");
  assert(liveReview.issues[0].severity === "warning" && liveReview.ok === true, "inconclusive REST probe does not falsely mark a live PBIR component as broken");
  assert(liveReview.issues[0].components[0].pageName === "Overview", "live review identifies affected page and visual component");

  if (failures.length) process.exit(1);
  console.log("\nOK: Fabric auth/API safety regressions passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
