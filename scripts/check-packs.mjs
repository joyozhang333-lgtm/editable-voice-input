import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = [
  "@editable-voice-input/core",
  "@editable-voice-input/react",
  "@editable-voice-input/server",
  "@editable-voice-input/provider-openai-compatible"
];
const forbiddenEntries = [
  /^package\/\.env(?:\.|$)/,
  /node_modules/,
  /(?:^|\/)src\/.*\.test\./,
  /(?:^|\/)coverage\//,
  /(?:^|\/)dist\/.*\.test\./,
  /\.(?:wav|mp3|m4a|ogg|webm|flac|bin)$/i
];
const temporaryRoot = mkdtempSync(join(tmpdir(), "editable-voice-input-pack-"));
const packDirectory = join(temporaryRoot, "packs");
const consumerDirectory = join(temporaryRoot, "consumer");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

try {
  const tarballs = [];
  for (const packageName of packages) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", packDirectory]);
    const candidates = readdirSync(packDirectory)
      .filter((filename) => filename.endsWith(".tgz"))
      .map((filename) => join(packDirectory, filename))
      .filter((filename) => !tarballs.includes(filename));
    if (candidates.length !== 1) {
      throw new Error(`${packageName} did not produce exactly one tarball.`);
    }
    const tarball = candidates[0];
    tarballs.push(tarball);

    const listing = run("tar", ["-tzf", tarball]).trim().split("\n");
    const forbidden = listing.filter((path) =>
      forbiddenEntries.some((pattern) => pattern.test(path))
    );
    if (forbidden.length) {
      throw new Error(`${packageName} contains forbidden packed files: ${forbidden.join(", ")}`);
    }
    for (const required of [
      "package/dist/index.js",
      "package/dist/index.cjs",
      "package/dist/index.d.ts",
      "package/LICENSE",
      "package/README.md"
    ]) {
      if (!listing.includes(required)) throw new Error(`${packageName} is missing ${required}.`);
    }

    const manifestText = run("tar", ["-xOf", tarball, "package/package.json"]);
    if (manifestText.includes("workspace:")) {
      throw new Error(`${packageName} still contains a workspace protocol in its packed manifest.`);
    }
    const manifest = JSON.parse(manifestText);
    if (manifest.name !== packageName || !manifest.version) {
      throw new Error(`${packageName} has an invalid packed manifest.`);
    }
    process.stdout.write(`${packageName}: ${listing.length} files in ${basename(tarball)}\n`);
  }

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "pack-consumer", version: "1.0.0", private: true, type: "module" })
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...tarballs
    ],
    { cwd: consumerDirectory }
  );

  writeFileSync(
    join(consumerDirectory, "check-esm.mjs"),
    `import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "@editable-voice-input/core";
import * as react from "@editable-voice-input/react";
import * as server from "@editable-voice-input/server";
import * as provider from "@editable-voice-input/provider-openai-compatible";
for (const value of [core, react, server, provider]) {
  if (!Object.keys(value).length) throw new Error("Empty ESM export");
}
const cssPath = fileURLToPath(import.meta.resolve("@editable-voice-input/react/styles.css"));
if (!existsSync(cssPath)) throw new Error("Missing exported CSS");
`
  );
  run("node", ["check-esm.mjs"], { cwd: consumerDirectory });

  writeFileSync(
    join(consumerDirectory, "check-cjs.cjs"),
    `for (const name of [
  "@editable-voice-input/core",
  "@editable-voice-input/react",
  "@editable-voice-input/server",
  "@editable-voice-input/provider-openai-compatible"
]) {
  if (!Object.keys(require(name)).length) throw new Error("Empty CJS export: " + name);
}
`
  );
  run("node", ["check-cjs.cjs"], { cwd: consumerDirectory });

  writeFileSync(
    join(consumerDirectory, "check-types.ts"),
    `import { BrowserVoiceCapture, type VoiceInputState } from "@editable-voice-input/core";
import { EditableVoiceInput, type UseVoiceInputOptions } from "@editable-voice-input/react";
import { createTranscriptionHandler, type TranscriptionProvider } from "@editable-voice-input/server";
import { createOpenAICompatibleProvider } from "@editable-voice-input/provider-openai-compatible";
void BrowserVoiceCapture; void EditableVoiceInput; void createTranscriptionHandler;
void createOpenAICompatibleProvider; let state: VoiceInputState; let options: UseVoiceInputOptions;
let provider: TranscriptionProvider; void state!; void options!; void provider!;
`
  );
  writeFileSync(
    join(consumerDirectory, "check-types.cts"),
    `import { BrowserVoiceCapture, type VoiceInputState } from "@editable-voice-input/core";
import { EditableVoiceInput, type UseVoiceInputOptions } from "@editable-voice-input/react";
import { createTranscriptionHandler, type TranscriptionProvider } from "@editable-voice-input/server";
import { createOpenAICompatibleProvider } from "@editable-voice-input/provider-openai-compatible";
void BrowserVoiceCapture; void EditableVoiceInput; void createTranscriptionHandler;
void createOpenAICompatibleProvider; let state: VoiceInputState; let options: UseVoiceInputOptions;
let provider: TranscriptionProvider; void state!; void options!; void provider!;
`
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        jsx: "react-jsx"
      },
      include: ["check-types.ts", "check-types.cts"]
    })
  );
  run(resolve(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
    cwd: consumerDirectory
  });

  process.stdout.write("tarball consumer: npm install, ESM, CJS, types, and CSS passed\n");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
