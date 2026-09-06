# `@editable-voice-input/adapter-guichu`

GuiChu Here-specific integration for `@editable-voice-input/core`. It keeps
`conversationId`, `sessionId`, and `ownerKey` out of the provider-neutral core.

This package is a reference integration contract. V0954 currently uses its own
voice implementation and does not import this SDK. This repository does not
provide product server routes, receipt storage, or database migrations; a host
must implement and transaction-test those parts before using the claim helper
in production.

`createGuichuVoiceTransport` wraps an authenticated product API that provides
an exact owner-scoped lookup by `clientTurnId` before upload. It automatically
stores the original conversation/session/owner scope as encrypted outbox
metadata, snapshots owner plus `identityEpoch` across lookup→upload, and rejects
or aborts an attempt whenever either changes. The host must supply an
`identitySignal` and abort it immediately at every login, logout, or claim
transition; the API implementation must honor the attempt signal. The server
may also implement `assertIdentityCurrent` as a defense-in-depth preflight. It
is not the authorization boundary: `findExact` and `upload` must atomically
reject a stale owner, session, or `identityEpoch` at their own database/write
boundary because a client abort cannot retract a request already delivered
over the network. The server must additionally enforce a unique `(owner, clientTurnId)`
constraint and return the existing message for concurrent conflicts.

`createGuichuOutboxCodec` binds a host-provided encryption implementation to
the current owner through an opaque `bindingTag` (for example, an HMAC). Do not
store raw account identifiers as tags. Its `context` must also return an
`identityEpoch` that changes for every login, logout, or authenticated claim;
the adapter rechecks owner plus epoch after each asynchronous crypto boundary
to close A→B→A identity races. The host must implement `seal`/`open`,
keep keys out of persistent plaintext storage, expire abandoned records, and
make account transitions explicit. Pass an opaque owner partition to the core
IndexedDB store. Its durable partition epoch prevents a delayed write in one
tab from reviving rows after another tab clears them. Call `outbox.clear()`
before logout/account switch. This is a best-effort client fence and cannot
retract a request already delivered to the server; strong revocation requires
an atomic server identity epoch/revocation check. For an authenticated
guest-to-account transition, use `claimGuichuIndexedDbOutboxRecord`. It refuses
legacy rows missing the original sealed GuiChu scope and requires a
`GuichuVoiceClaimApi.claimOrReconcile` call first. That server operation must,
in one transaction, authenticate both scopes, reconcile an existing guest
message or reserve the turn for the account, revoke further source-owner
uploads, and return the same durable receipt on response-loss retry. Only a
matching receipt, bound to both conversation IDs, session IDs, owners, identity
epochs, and the client turn ID, allows the helper to CAS both local epochs, re-encrypt,
re-key, and remove the guest row. The helper links source identity, target
identity, and caller abort signals across the server wait and local IndexedDB
transaction, so an invalidated identity cannot finish the move. Core send leases recheck that durable
epoch/revision around lookup and immediately before upload, then conditionally
delete only the sent revision. The adapter does not ship a key or choose a
retention policy.

The helper claims one pending turn at a time. For several pending recordings,
enumerate the batch before switching identity, keep a durable server batch
grant (or per-turn source authorization) until every selected turn is claimed,
and only then revoke the source globally. Do not abort the migration identity
signal or destroy its encryption key after the first row. A failed batch must
remain resumable through the same idempotent server receipts. Batch
orchestration is a host responsibility; the helper is not a batch transaction.
