import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", ".next", "node_modules", "coverage"]);
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".cjs",
  ".map",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["cloud access key", /AKIA[0-9A-Z]{16}/],
  ["Tencent Cloud access key", /\bAKID[A-Za-z0-9]{32}\b/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{30,}/],
  ["provider token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  [
    "assigned secret",
    /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD)[ \t]*=[ \t]*["']?[^\s"']{12,}/i
  ]
];
const forbiddenBinaryExtensions = new Set([
  ".aac",
  ".bin",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
  ".webm"
]);
const findings = [];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    const path = relative(root, absolute);
    if (forbiddenBinaryExtensions.has(extension)) {
      findings.push(`${path}: bundled audio or model artifact`);
      continue;
    }
    const isEnvironmentExample = entry.name.endsWith(".env.example");
    const maximumTextBytes = extension === ".map" ? 10_000_000 : 1_000_000;
    if (
      (!textExtensions.has(extension) && !isEnvironmentExample) ||
      statSync(absolute).size > maximumTextBytes
    ) {
      continue;
    }
    const content = readFileSync(absolute, "utf8");
    for (const [label, pattern] of patterns) {
      if (pattern.test(content)) findings.push(`${path}: ${label}`);
    }
  }
}

visit(root);
if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("No embedded credentials, private keys, audio files, or model weights detected.\n");
}
