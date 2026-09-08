import { build } from "tsup";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const outDir = join(root, "dist/vendor");
await mkdir(outDir, { recursive: true });
const metadata = [];
const common = {
  outDir, config: false, splitting: false, sourcemap: false, noExternal: [/.*/],
  esbuildOptions(options) { options.metafile = true; },
  esbuildPlugins: [{ name: "vendor-inventory", setup(builder) {
    builder.onEnd((result) => { if (result.metafile) metadata.push(result.metafile); });
  } }]
};
await build({ ...common, entry: { "press-to-talk": "packages/core/src/browser.ts" },
  platform: "browser", target: "es2022", minify: true, format: ["esm", "iife"],
  globalName: "EditableVoiceInputCore",
  outExtension: ({ format }) => ({ js: format === "iife" ? ".iife.js" : ".js" }) });
await build({ ...common, entry: { "server.bundle": "vendor/server.ts" },
  platform: "node", target: "node20", format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }) });

const dependencies = new Map();
for (const meta of metadata) {
  for (const input of Object.keys(meta.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(root, input));
    while (!existsSync(join(directory, "package.json"))) {
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Missing package manifest: ${input}`);
      directory = parent;
    }
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const key = `${manifest.name}@${manifest.version}`;
    if (dependencies.has(key)) continue;
    const licenses = (await readdir(directory)).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
    if (!licenses.length) throw new Error(`Missing license notice for ${key}`);
    dependencies.set(key, { license: manifest.license, text:
      (await Promise.all(licenses.map((file) => readFile(join(directory, file), "utf8")))).join("\n\n") });
  }
}
const notices = ["# Bundled Third-Party Notices", "Generated from the bundled dependency graph. Keep this file when vendoring."];
for (const [key, value] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
  notices.push(`## ${key} (${value.license})\n\n${value.text}`);
}
await writeFile(join(outDir, "THIRD_PARTY_NOTICES.md"), notices.join("\n\n") + "\n");
await copyFile(join(root, "LICENSE"), join(outDir, "LICENSE"));
await writeFile(join(outDir, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n");
const { version } = JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8"));
const files = {};
for (const name of ["press-to-talk.js", "press-to-talk.iife.js", "server.bundle.cjs", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json"]) {
  const data = await readFile(join(outDir, name));
  files[name] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
await writeFile(join(outDir, "manifest.json"), JSON.stringify({ version, files }, null, 2) + "\n");
console.log(JSON.stringify({ version, files }, null, 2));
