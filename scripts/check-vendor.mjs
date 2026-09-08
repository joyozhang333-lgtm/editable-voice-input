import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

const directory = resolve(import.meta.dirname, "../dist/vendor");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = readFileSync(join(directory, name));
  assert.equal(bytes.length, expected.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
}
const browser = readFileSync(join(directory, "press-to-talk.iife.js"), "utf8");
assert.ok(Buffer.byteLength(browser) < 40_000, "Browser IIFE must stay below 40 kB raw");
assert.ok(gzipSync(browser).length < 12_000, "Browser IIFE must stay below 12 kB gzip");
const context = { Blob, AbortController, crypto: webcrypto, setInterval, clearInterval };
runInNewContext(browser, context, { timeout: 1000 });
const esm = await import(pathToFileURL(join(directory, "press-to-talk.js")));
for (const api of [context.EditableVoiceInputCore, esm]) {
  assert.equal(typeof api.PressToTalkController, "function");
  assert.equal(typeof api.bindPressToTalk, "function");
  assert.equal(typeof api.BrowserVoiceCapture, "function");
  assert.equal(api.DirectAudioOutbox, undefined);
  assert.equal(api.BrowserWebSpeechDictationProvider, undefined);
  const blob = new Blob(["synthetic"]);
  const audio = { blob, size: blob.size, durationMs: 1000, mimeType: "audio/webm" };
  let resolve;
  let received;
  const result = new Promise((yes) => { resolve = yes; });
  const controller = new api.PressToTalkController({ sessionKey: "synthetic-scope",
    capture: { start: async () => ({ result, active: true, stop: () => { resolve(audio); return result; }, cancel() {} }), cancel() {}, dispose() {} },
    onCommit: (input) => { received = input; return "Synthetic transcript"; } });
  await controller.start({ intent: "dictate" });
  controller.stop();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(received.intent, "dictate");
  assert.equal(received.sessionKey, "synthetic-scope");
  assert.equal(controller.getSnapshot().text, "Synthetic transcript");
  controller.dispose();
}

const temporary = mkdtempSync(join(tmpdir(), "evi-vendor-consumer-"));
try {
  copyFileSync(join(directory, "server.bundle.cjs"), join(temporary, "server.bundle.cjs"));
  execFileSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function(name, ...args) {
      assert.ok(Module.isBuiltin(name) || name === './server.bundle.cjs', 'External runtime dependency: ' + name);
      return resolve.call(this, name, ...args);
    };
    const api = require('./server.bundle.cjs');
    const wav = Buffer.alloc(16044);
    wav.write('RIFF'); wav.writeUInt32LE(16036, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    (async () => {
      assert.equal(await api.inspectAudioDurationMs(wav, 'audio/wav'), 1000);
      let requested = false;
      const provider = api.createOpenAICompatibleProvider({ apiKey: 'synthetic-test-key',
        baseUrl: 'https://provider.example.test/v1', fetch: async (url, request) => {
          requested = true;
          assert.equal(new Headers(request.headers).get('authorization'), 'Bearer synthetic-test-key');
          assert.ok(request.body.get('file') instanceof Blob);
          return Response.json({text: 'Synthetic transcript'});
        }
      });
      assert.throws(() => api.createTranscriptionHandler({ provider }), /authorize/);
      const handle = api.createTranscriptionHandler({ provider, authorize: async () => undefined,
        maxBytes: 20000, maxDurationMs: 2000 });
      const response = await handle(new Request('https://app.example.test/api/transcribe', {
        method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'audio/wav' }, body: wav
      }));
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('cache-control').includes('no-store'));
      assert.equal((await response.json()).text, 'Synthetic transcript');
      assert.ok(requested);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: temporary, stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`Vendor checks passed: IIFE, ESM, isolated Node CJS with real duration parsing; browser ${Buffer.byteLength(browser)} bytes / ${gzipSync(browser).length} gzip.`);
