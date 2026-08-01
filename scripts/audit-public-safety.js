#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const includedRoots = [
  "src",
  "scripts",
  "skills",
  "configs",
  "docs",
  "plugin",
];
const includedFiles = [
  "README.md",
  "ARCHITECTURE.md",
  "BACKLOG.md",
  "CONTRIBUTING.md",
  "tests.md",
  "package.json",
];
const extensions = new Set([".ts", ".js", ".json", ".md", ".yml", ".yaml", ".toml"]);

const rules = [
  ["non-placeholder UUID", /\b(?!0{8}-0{4}-0{4}-0{4}-0{12}\b)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi],
  ["non-example email address", /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net|test)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["non-placeholder Linux home paths", /\/home\/(?!your-user(?:\/|$))[A-Za-z0-9._-]+/g],
  ["JWT-like bearer material", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g],
];

const files = [];
function walk(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
    return;
  }
  if (extensions.has(path.extname(target))) files.push(target);
}
for (const root of includedRoots) walk(path.join(ROOT, root));
for (const file of includedFiles) walk(path.join(ROOT, file));

const findings = [];
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  for (const [label, regex] of rules) {
    regex.lastIndex = 0;
    const match = regex.exec(content);
    if (match) findings.push({ file: path.relative(ROOT, file), label, match: match[0] });
  }
}

if (findings.length) {
  console.error("Public-safety audit failed:");
  for (const finding of findings) console.error(`  ${finding.file}: ${finding.label} (${finding.match})`);
  process.exit(1);
}
console.log(`Public-safety audit passed (${files.length} files): no real UUIDs, user home paths, non-example emails, or token material.`);
