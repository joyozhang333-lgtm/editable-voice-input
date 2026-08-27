# @editable-voice-input/server

Framework-neutral helpers for bounded raw audio requests, real container-duration inspection, content signature validation, provider calls, and private no-store JSON responses.

The handler fails closed unless `authorize` is provided. `allowUnauthenticated: true` is available only for endpoints that are deliberately public. An `Origin` header is required and defaults to strict same-origin validation; `allowedOrigins` can explicitly add cross-origin clients. Non-browser server clients must deliberately set `allowMissingOrigin: true` and still authenticate. Use `consumeQuota` to apply a server-side per-user/IP rate or billing quota before audio is parsed or sent upstream.

```ts
const handle = createTranscriptionHandler({
  provider,
  authorize: async (request) => {
    const session = await readSession(request);
    if (!session) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  },
  consumeQuota: async (request) => rateLimiter.consume(request),
  maxDurationMs: 120_000,
  maxBytes: 8 * 1024 * 1024
});
```

Authentication and quota callbacks are integration points, not bundled identity or distributed rate-limit systems. In multi-instance deployments, back quotas with a shared atomic store.
