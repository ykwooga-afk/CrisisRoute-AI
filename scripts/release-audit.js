"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "README.md",
  "README-HANDOFF.md",
  "LICENSE",
  "SECURITY.md",
  "PRIVACY.md",
  "render.yaml",
  ".nvmrc",
  "package-lock.json",
  "backend/publicSourceExtractor.js",
  "docs/README.md",
  "docs/DEMO_RUNBOOK.md",
  "docs/GONKA_INTEGRATION.md",
  "docs/SUBMISSION_CHECKLIST.md",
  "docs/PITCH_SCRIPT_2_MIN.md",
  "tests/public-source-extractor.test.js",
  "tests/production-release.test.js"
];
const requiredReadmeSections = [
  "Problem",
  "Product Workflow",
  "Why Gonka Is Essential",
  "Three-Axis Scoring",
  "Deterministic Consensus",
  "Safety Gates",
  "Human Decision",
  "Deterministic Brief",
  "Local Proof Capsule",
  "Data Modes",
  "Architecture",
  "Repository Structure",
  "Local Setup",
  "Available Commands",
  "API Routes",
  "Render Deployment",
  "Testing",
  "Security and Privacy",
  "Known Limitations",
  "Demo and Submission",
  "License"
];

const failures = [];
function check(condition, label) {
  if (!condition) failures.push(label);
}
function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
function candidateFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  return output.split(/\r?\n/).filter(Boolean).filter(file =>
    file !== ".env" &&
    file !== ".env.local" &&
    !/^\.env\..*\.local$/i.test(file) &&
    !file.startsWith("dist/") &&
    !file.startsWith("node_modules/")
  );
}

for (const file of requiredFiles) check(fs.existsSync(path.join(root, file)), `missing:${file}`);

let packageJson;
let lockfile;
try {
  packageJson = JSON.parse(read("package.json"));
  lockfile = JSON.parse(read("package-lock.json"));
} catch {
  failures.push("invalid:package-json-or-lockfile");
}
if (packageJson) {
  check(Object.keys(packageJson.dependencies || {}).length === 0, "package:runtime-dependencies-present");
  check(Object.keys(packageJson.devDependencies || {}).length === 0, "package:dev-dependencies-present");
  check(packageJson.engines?.node === ">=24 <25", "package:node-engine");
  check(packageJson.scripts?.["audit:release"] === "node scripts/release-audit.js", "package:audit-script");
}
if (lockfile) {
  check(Object.keys(lockfile.packages || {}).length === 1, "lockfile:dependencies-present");
}

const tracked = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
}).split(/\r?\n/).filter(Boolean);
check(!tracked.some(file => file === ".env" || file === ".env.local" || /^\.env\..*\.local$/i.test(file)), "git:private-env-tracked");
check(!fs.existsSync(path.join(root, "node_modules")), "filesystem:node_modules-present");

const render = read("render.yaml");
const renderServiceTypes = [...render.matchAll(/^  - type:\s*(\S+)\s*$/gm)].map(match => match[1]);
const renderPlans = [...render.matchAll(/^\s+plan:\s*(\S+)\s*$/gm)].map(match => match[1]);
function renderServiceField(name) {
  const matches = [...render.matchAll(new RegExp(`^    ${name}:\\s*([^\\r\\n]+)\\s*$`, "gm"))];
  return matches.length === 1 ? matches[0][1].trim() : null;
}
const gonkaApiKeyBlocks = [...render.matchAll(
  /^      - key:\s*GONKA_API_KEY\s*\r?\n((?:^        [^\r\n]*(?:\r?\n|$))*)/gm
)];

check(renderServiceTypes.length === 1, "render:service-count");
check(renderServiceTypes.length === 1 && renderServiceTypes[0] === "web", "render:service-not-web");
check(renderServiceField("runtime") === "node", "render:runtime-not-node");
check(renderPlans.length === 1, "render:plan-missing-or-duplicate");
check(renderPlans.length === 1 && renderPlans[0] === "free", "render:plan-not-free");
check(renderServiceField("region") === "singapore", "render:region-not-singapore");
check(renderServiceField("branch") === "main", "render:branch-not-main");
check(
  !/^(?:databases|envVarGroups):/m.test(render) &&
    !/^\s+(?:disk|diskSizeGB|previewDiskSizeGB):/m.test(render) &&
    !/^  - type:\s*(?:pserv|worker|cron|keyvalue|redis)\s*$/m.test(render) &&
    renderPlans.every(plan => plan === "free"),
  "render:unexpected-billable-resource"
);
check(gonkaApiKeyBlocks.length === 1, "render:key-placeholder-count");
check(
  gonkaApiKeyBlocks.length === 1 && gonkaApiKeyBlocks[0][1].trim() === "sync: false",
  "render:key-placeholder-shape"
);
for (const fragment of [
  "runtime: node",
  "buildCommand: npm ci --omit=dev",
  "startCommand: npm start",
  "healthCheckPath: /api/health/ready",
  "value: 0.0.0.0",
  "value: production",
  "value: https://api.gonkarouter.io/v1",
  "value: deepseek-ai/DeepSeek-V4-Flash-0731",
  "value: moonshotai/Kimi-K2.6"
]) check(render.includes(fragment), `render:missing:${fragment}`);
check(/key:\s*GONKA_API_KEY\s*\r?\n\s*sync:\s*false/.test(render), "render:key-not-manual-secret");
check(!/GONKA_API_KEY\s*\r?\n\s*value:/i.test(render), "render:key-value-present");
check(!/\bPORT\b\s*\r?\n\s*value:/i.test(render), "render:port-hardcoded");

const files = candidateFiles();
let secretMatches = 0;
let liveResponseIdMatches = 0;
for (const file of files) {
  let content;
  try {
    content = fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  const secrets = content.match(/sk-[A-Za-z0-9_-]{16,}/g) || [];
  secretMatches += secrets.filter(value =>
    !/(?:MUST-NOT|SENTINEL)/i.test(value) &&
    !/^sk-(?:TEST|SERVER|UNIT|FAKE|EXAMPLE)-/i.test(value)
  ).length;
  const ids = content.match(/(?:chatcmpl|req|resp|response)-[A-Za-z0-9_-]{16,}/gi) || [];
  liveResponseIdMatches += ids.filter(value => !/(?:mock|test|example|placeholder|response-public-url|demo-response-public-url)/i.test(value)).length;
}
check(secretMatches === 0, "scan:secret-shaped-content");
check(liveResponseIdMatches === 0, "scan:live-response-id");

const readme = read("README.md");
for (const section of requiredReadmeSections) {
  check(readme.includes(`## ${section}`), `readme:missing-section:${section}`);
}
for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const target = match[1].trim();
  if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
  check(fs.existsSync(path.resolve(root, target)), `readme:broken-link:${target}`);
}

const handoffAndDocs = `${read("README-HANDOFF.md")}\n${read("docs/README.md")}`;
check(!/Backend Next|Frontend locked, Gonka backend next/i.test(handoffAndDocs), "docs:obsolete-handoff-status");
check(/Historical Planning Documents/i.test(read("docs/README.md")), "docs:historical-label-missing");

const server = read("server.js");
const productionTests = read("tests/production-release.test.js");
const frontend = read("src/main.js");
const client = read("src/services/crisisRouteClient.js");
const publicExtractor = read("backend/publicSourceExtractor.js");
check(server.includes('"/api/health/ready"'), "server:ready-route-missing");
check(server.includes("GONKA_LIVE_ENABLED"), "server:live-gate-missing");
check(server.includes("ANALYSIS_LIMIT_REACHED"), "server:budget-missing");
check(server.includes('"/api/public-source/analyze"'), "server:public-url-route-missing");
check(server.includes("publicSourceExtractor"), "server:public-url-extractor-missing");
check(productionTests.includes("Production"), "tests:production-safety-missing");
check(frontend.includes("Paste a crisis report or public source URL"), "frontend:url-entry-copy-missing");
check(frontend.includes("Publicly accessible HTTP/HTTPS pages only"), "frontend:url-safety-copy-missing");
check(frontend.includes("analyzePublicUrl"), "frontend:url-flow-missing");
check(client.includes("analyzePublicUrl"), "client:url-adapter-missing");
check(
  publicExtractor.includes("PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED") &&
    publicExtractor.includes("PUBLIC_URL_PRIVATE_HOST_BLOCKED"),
  "public-url:ssrf-private-block-missing"
);
check(publicExtractor.includes("PUBLIC_URL_UNSUPPORTED_CONTENT_TYPE"), "public-url:content-type-guard-missing");
check(publicExtractor.includes("PUBLIC_URL_TOO_LARGE"), "public-url:size-guard-missing");
check(publicExtractor.includes("PUBLIC_URL_TIMEOUT"), "public-url:timeout-guard-missing");
check(!frontend.includes("Public URL content retrieval is not included in this demo."), "frontend:obsolete-url-limitation-present");
check(/local payload-integrity evidence only/i.test(readme), "readme:proof-limitation-missing");
check(/ephemeral/i.test(readme), "readme:ephemeral-limitation-missing");
check(/earlier accepted Live run/i.test(readme), "readme:replay-provenance-missing");

const checklist = read("docs/SUBMISSION_CHECKLIST.md");
for (const placeholder of ["[ADD_GITHUB_URL]", "[ADD_LIVE_DEMO_URL]", "[ADD_VIDEO_URL]"]) {
  check(checklist.includes(placeholder), `checklist:missing:${placeholder}`);
}

if (failures.length) {
  console.error("B12-A Release Audit: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("B12-A Release Audit: PASS");
  console.log(`Files inspected: ${files.length}`);
  console.log(`Secret-shaped matches: ${secretMatches}`);
  console.log(`Live Response ID matches: ${liveResponseIdMatches}`);
  console.log("Private env files read: 0");
  console.log("External network requests: 0");
}
