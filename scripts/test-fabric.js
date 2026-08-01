#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FabricAuthManager } = require("../dist/fabricAuth.js");
const { FabricApiClient, collectReportDefinitionParts } = require("../dist/fabricApi.js");

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
      return new Response(JSON.stringify({ subfolders: [{ id: 151720, displayName: "Test", objectId: "folder-uuid" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const api = new FabricApiClient(auth, fetcher);
  const byName = await api.resolveFolder("workspace", "Test");
  const byLegacy = await api.resolveFolder("workspace", "151720");
  assert(byName.id === "folder-uuid", "folder resolver accepts exact display name");
  assert(byLegacy.id === "folder-uuid" && byLegacy.legacyId === 151720, "folder resolver maps legacy numeric subfolderId to UUID");
  assert(requests.every((request) => String(request.init.headers.Authorization).startsWith("Bearer ")), "Fabric requests use private authorization headers");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pbir-parts-"));
  fs.mkdirSync(path.join(temp, "definition"));
  fs.writeFileSync(path.join(temp, "definition.pbir"), "{}", "utf8");
  fs.writeFileSync(path.join(temp, "definition", "report.json"), "{}", "utf8");
  const parts = collectReportDefinitionParts(temp);
  assert(parts.length === 2 && parts.every((part) => part.payloadType === "InlineBase64"), "report publisher packages PBIR files as inline base64 parts");
  fs.rmSync(temp, { recursive: true, force: true });

  const fabricToolsSource = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "fabric.ts"), "utf8");
  assert(fabricToolsSource.includes("confirmationRequired: true"), "remote publishing has an explicit confirmation gate");
  assert(fabricToolsSource.includes("Refusing to overwrite non-empty directory"), "project creation refuses to overwrite existing content");
  assert(!fabricToolsSource.includes("structuredContent: token"), "Fabric tools do not place tokens in structured responses");

  if (failures.length) process.exit(1);
  console.log("\nOK: Fabric auth/API safety regressions passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
