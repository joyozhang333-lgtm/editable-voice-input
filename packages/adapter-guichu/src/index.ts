import {
  validateDirectAudioMessage,
  type CapturedAudio,
  type DirectAudioMessage,
  type DirectAudioReconciliationAttempt,
  type DirectAudioOutboxCodec,
  type DirectAudioOutboxRecord,
  type IndexedDbDirectAudioOutboxStore,
  type ReconciliableDirectAudioTransport
} from "@editable-voice-input/core";

export interface GuichuVoiceContext {
  conversationId: string;
  sessionId: string;
  ownerKey: string;
  /** Changes for every login, logout, or authenticated guest claim. */
  identityEpoch: string | number;
  /** Host aborts this signal immediately when identityEpoch changes. */
  identitySignal?: AbortSignal;
}

export type GuichuVoiceRequestContext = Omit<GuichuVoiceContext, "identitySignal">;

export interface GuichuVoiceMessage {
  voiceMessageId: string;
  clientTurnId: string;
  createdAt: string;
  playbackUrl: string;
  mimeType: string;
  durationMs?: number;
  /** @deprecated Kept only for older GuiChu route responses. */
  durationSeconds?: number;
  size: number;
  transcript?: string;
}

export interface GuichuVoiceApi {
  /**
   * Optional defense-in-depth preflight. The definitive check still belongs in
   * findExact/upload, which must atomically reject a stale owner+identityEpoch.
   */
  assertIdentityCurrent?(input: GuichuVoiceRequestContext & {
    signal?: AbortSignal;
  }): Promise<void>;
  /** Exact, owner-authorized lookup; another owner's match must be indistinguishable from missing. */
  findExact(input: GuichuVoiceRequestContext & {
    clientTurnId: string;
    signal?: AbortSignal;
  }): Promise<GuichuVoiceMessage | null>;
  /** Atomically upsert `(owner, clientTurnId)` and return the existing message on conflict. */
  upload(input: GuichuVoiceRequestContext & {
    clientTurnId: string;
    audio: CapturedAudio;
    signal?: AbortSignal;
  }): Promise<GuichuVoiceMessage>;
}

export interface GuichuVoiceClaimReceipt {
  version: 1;
  /** Opaque, durable, idempotently returned server receipt. */
  receiptId: string;
  clientTurnId: string;
  sourceConversationId: string;
  sourceSessionId: string;
  sourceOwnerKey: string;
  sourceIdentityEpoch: string;
  targetConversationId: string;
  targetSessionId: string;
  targetOwnerKey: string;
  targetIdentityEpoch: string;
  /** `reconciled` means an existing guest message was rebound or aliased. */
  disposition: "reserved" | "reconciled";
}

export interface GuichuVoiceClaimApi {
  /**
   * Server authorization boundary for guest→account recovery. In one database
   * transaction this must authenticate both scopes, reconcile an existing
   * source message or reserve the turn for the target, revoke source writes
   * for this turn, and return the same receipt when retried after response
   * loss. A host migrating several rows must keep a durable batch grant until
   * every per-turn claim completes before globally revoking the source.
   */
  claimOrReconcile(input: {
    source: GuichuVoiceRequestContext;
    target: GuichuVoiceRequestContext;
    clientTurnId: string;
    signal?: AbortSignal;
  }): Promise<GuichuVoiceClaimReceipt>;
}

export interface GuichuVoiceTransportOptions {
  context: () => GuichuVoiceContext;
  api: GuichuVoiceApi;
}

export const GUICHU_OUTBOX_CONVERSATION_KEY = "guichu.conversationId";
export const GUICHU_OUTBOX_SESSION_KEY = "guichu.sessionId";
export const GUICHU_OUTBOX_OWNER_KEY = "guichu.ownerKey";
export const GUICHU_OUTBOX_IDENTITY_EPOCH_KEY = "guichu.identityEpoch";
export const GUICHU_OUTBOX_CLAIM_RECEIPT_KEY = "guichu.claimReceiptId";

function identityEpochToken(epoch: string | number): string {
  return `${typeof epoch}:${String(epoch)}`;
}

export function createGuichuOutboxMetadata(
  context: GuichuVoiceContext,
  metadata: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
  return {
    ...metadata,
    [GUICHU_OUTBOX_CONVERSATION_KEY]: context.conversationId,
    [GUICHU_OUTBOX_SESSION_KEY]: context.sessionId,
    [GUICHU_OUTBOX_OWNER_KEY]: context.ownerKey,
    [GUICHU_OUTBOX_IDENTITY_EPOCH_KEY]: identityEpochToken(context.identityEpoch)
  };
}

function contextForAttempt(
  current: GuichuVoiceContext,
  metadata?: Readonly<Record<string, string>>
): GuichuVoiceContext {
  const conversationId = metadata?.[GUICHU_OUTBOX_CONVERSATION_KEY];
  const sessionId = metadata?.[GUICHU_OUTBOX_SESSION_KEY];
  const ownerKey = metadata?.[GUICHU_OUTBOX_OWNER_KEY];
  const identityEpoch = metadata?.[GUICHU_OUTBOX_IDENTITY_EPOCH_KEY];
  if (!conversationId || !sessionId || !ownerKey || !identityEpoch) {
    throw new GuichuVoiceScopeError(
      "Pending audio is missing its sealed GuiChu conversation or identity scope."
    );
  }
  if (ownerKey !== current.ownerKey) {
    throw new GuichuVoiceScopeError(
      "Pending audio belongs to a different GuiChu owner. Clear or explicitly claim it before retrying."
    );
  }
  if (identityEpoch !== identityEpochToken(current.identityEpoch)) {
    throw new GuichuVoiceScopeError(
      "Pending audio belongs to a stale GuiChu identity epoch."
    );
  }
  return { ...current, conversationId, sessionId };
}

export class GuichuVoiceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuichuVoiceScopeError";
  }
}

function assertRecordScope(
  record: DirectAudioOutboxRecord,
  context: GuichuVoiceContext
): void {
  const scoped = contextForAttempt(context, record.metadata);
  if (
    scoped.conversationId !== context.conversationId ||
    scoped.sessionId !== context.sessionId
  ) {
    throw new GuichuVoiceScopeError(
      "Pending audio belongs to a different GuiChu conversation or session."
    );
  }
}

function validateClaimReceipt(
  receipt: GuichuVoiceClaimReceipt,
  input: {
    clientTurnId: string;
    source: GuichuVoiceContext;
    target: GuichuVoiceContext;
  }
): GuichuVoiceClaimReceipt {
  if (
    receipt.version !== 1 ||
    !receipt.receiptId?.trim() ||
    receipt.receiptId.length > 512 ||
    receipt.clientTurnId !== input.clientTurnId ||
    receipt.sourceConversationId !== input.source.conversationId ||
    receipt.sourceSessionId !== input.source.sessionId ||
    receipt.sourceOwnerKey !== input.source.ownerKey ||
    receipt.sourceIdentityEpoch !== identityEpochToken(input.source.identityEpoch) ||
    receipt.targetConversationId !== input.target.conversationId ||
    receipt.targetSessionId !== input.target.sessionId ||
    receipt.targetOwnerKey !== input.target.ownerKey ||
    receipt.targetIdentityEpoch !== identityEpochToken(input.target.identityEpoch) ||
    (receipt.disposition !== "reserved" && receipt.disposition !== "reconciled")
  ) {
    throw new GuichuVoiceScopeError(
      "The server returned an invalid GuiChu voice claim receipt."
    );
  }
  return receipt;
}

function claimGuichuOutboxRecord(
  record: DirectAudioOutboxRecord,
  context: GuichuVoiceContext,
  receipt: GuichuVoiceClaimReceipt
): DirectAudioOutboxRecord {
  return {
    ...record,
    metadata: createGuichuOutboxMetadata(context, {
      ...record.metadata,
      [GUICHU_OUTBOX_CLAIM_RECEIPT_KEY]: receipt.receiptId
    })
  };
}

function claimAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new GuichuVoiceScopeError("The GuiChu voice claim was cancelled.");
}

function throwIfClaimAborted(signal: AbortSignal): void {
  if (signal.aborted) throw claimAbortError(signal);
}

function linkClaimSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const uniqueSignals = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
  const aborters = new Map<AbortSignal, () => void>();
  for (const signal of uniqueSignals) {
    const abort = (): void => controller.abort(signal.reason);
    aborters.set(signal, abort);
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, abort] of aborters) signal.removeEventListener("abort", abort);
    }
  };
}

function waitForClaimOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(claimAbortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * Durable guest→account claim. A local re-key is forbidden until the server has
 * atomically reconciled/reserved the turn and returned a validated durable
 * receipt. Source and target partition epochs are then CASed in one IndexedDB
 * transaction; response-loss retries call the idempotent server operation again.
 */
export async function claimGuichuIndexedDbOutboxRecord<TargetPayload>(input: {
  store: IndexedDbDirectAudioOutboxStore;
  clientTurnId: string;
  targetPartition: string;
  targetCodec: DirectAudioOutboxCodec<TargetPayload>;
  sourceContext: GuichuVoiceContext;
  targetContext: GuichuVoiceContext;
  api: GuichuVoiceClaimApi;
  signal?: AbortSignal;
}): Promise<{ record: DirectAudioOutboxRecord; receipt: GuichuVoiceClaimReceipt }> {
  const linked = linkClaimSignals([
    input.signal,
    input.sourceContext.identitySignal,
    input.targetContext.identitySignal
  ]);
  try {
    throwIfClaimAborted(linked.signal);
    const pending = await input.store.get(input.clientTurnId);
    throwIfClaimAborted(linked.signal);
    if (!pending) {
      throw new GuichuVoiceScopeError("The pending GuiChu audio turn was not found.");
    }
    // Fail closed before making a server mutation when a legacy row has no
    // sealed product scope or belongs to some other guest session.
    assertRecordScope(pending, input.sourceContext);
    const { identitySignal: _sourceSignal, ...source } = input.sourceContext;
    const { identitySignal: _targetSignal, ...target } = input.targetContext;
    const receipt = validateClaimReceipt(
      await waitForClaimOperation(
        input.api.claimOrReconcile({
          source,
          target,
          clientTurnId: input.clientTurnId,
          signal: linked.signal
        }),
        linked.signal
      ),
      {
        clientTurnId: input.clientTurnId,
        source: input.sourceContext,
        target: input.targetContext
      }
    );
    throwIfClaimAborted(linked.signal);
    const record = await input.store.claimTo({
      clientTurnId: input.clientTurnId,
      targetPartition: input.targetPartition,
      targetCodec: input.targetCodec,
      transform: (record) => {
        assertRecordScope(record, input.sourceContext);
        return claimGuichuOutboxRecord(record, input.targetContext, receipt);
      },
      signal: linked.signal
    });
    return { record, receipt };
  } finally {
    linked.dispose();
  }
}

function toCoreMessage(message: GuichuVoiceMessage): DirectAudioMessage {
  return validateDirectAudioMessage({
    id: message.voiceMessageId,
    clientMessageId: message.clientTurnId,
    kind: "audio",
    createdAt: message.createdAt,
    audio: {
      url: message.playbackUrl,
      mimeType: message.mimeType,
      ...(message.durationMs !== undefined
        ? { durationMs: message.durationMs }
        : { durationSeconds: message.durationSeconds }),
      size: message.size
    },
    ...(message.transcript !== undefined ? { transcript: message.transcript } : {})
  });
}

/** Keeps conversation/session/owner fields outside the product-neutral core. */
export function createGuichuVoiceTransport(
  options: GuichuVoiceTransportOptions
): ReconciliableDirectAudioTransport {
  const scoped = (context: GuichuVoiceContext): DirectAudioReconciliationAttempt => {
    const { identitySignal, ...requestContext } = context;
    const execute = async <T>(
      signal: AbortSignal | undefined,
      operation: (attemptSignal: AbortSignal) => Promise<T>
    ): Promise<T> => {
      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort(signal?.reason);
      const abortFromIdentity = (): void => controller.abort(identitySignal?.reason);
      if (signal?.aborted) abortFromCaller();
      else signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (identitySignal?.aborted) abortFromIdentity();
      else identitySignal?.addEventListener("abort", abortFromIdentity, { once: true });
      const assertCurrent = (): void => {
        const current = options.context();
        if (
          identitySignal?.aborted ||
          current.ownerKey !== context.ownerKey ||
          current.identityEpoch !== context.identityEpoch
        ) {
          controller.abort(new Error("GuiChu identity epoch changed."));
          throw new GuichuVoiceScopeError(
            "GuiChu identity changed during a voice reconciliation attempt."
          );
        }
        if (signal?.aborted) {
          controller.abort(signal.reason);
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Voice reconciliation was cancelled.");
        }
      };
      try {
        assertCurrent();
        await options.api.assertIdentityCurrent?.({
          ...requestContext,
          signal: controller.signal
        });
        assertCurrent();
        const result = await operation(controller.signal);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortFromCaller);
        identitySignal?.removeEventListener("abort", abortFromIdentity);
      }
    };
    return {
      async find({ clientMessageId, signal }) {
        const message = await execute(signal, (attemptSignal) =>
          options.api.findExact({
            ...requestContext,
            clientTurnId: clientMessageId,
            signal: attemptSignal
          })
        );
        return message ? toCoreMessage(message) : null;
      },
      async upload({ clientMessageId, audio, signal }) {
        return toCoreMessage(
          await execute(signal, (attemptSignal) =>
            options.api.upload({
              ...requestContext,
              clientTurnId: clientMessageId,
              audio,
              signal: attemptSignal
            })
          )
        );
      }
    };
  };
  return {
    find(input) {
      return scoped(options.context()).find(input);
    },
    upload(input) {
      return scoped(options.context()).upload(input);
    },
    beginAttempt({ metadata }) {
      return scoped(contextForAttempt(options.context(), metadata));
    },
    prepareMetadata(metadata) {
      return createGuichuOutboxMetadata(options.context(), metadata);
    }
  };
}

export interface GuichuSealedOutboxEnvelope<SealedPayload> {
  /** Opaque HMAC/hash supplied by the host; never persist raw account identifiers here. */
  bindingTag: string;
  sealed: SealedPayload;
}

export interface GuichuOutboxIdentityContext {
  ownerKey: string;
  /** Monotonic or otherwise unique for every login/logout/claim transition. */
  identityEpoch: string | number;
}

export interface GuichuOutboxCodecOptions<SealedPayload> {
  context: () => GuichuOutboxIdentityContext;
  bindingTag(input: GuichuOutboxIdentityContext): string | Promise<string>;
  seal(input: {
    record: DirectAudioOutboxRecord;
    ownerKey: string;
    identityEpoch: string | number;
  }): Promise<SealedPayload>;
  open(input: {
    sealed: SealedPayload;
    ownerKey: string;
    identityEpoch: string | number;
  }): Promise<DirectAudioOutboxRecord>;
}

function assertIdentityUnchanged(
  current: () => GuichuOutboxIdentityContext,
  expected: GuichuOutboxIdentityContext
): void {
  const latest = current();
  if (
    latest.ownerKey !== expected.ownerKey ||
    latest.identityEpoch !== expected.identityEpoch
  ) {
    throw new GuichuVoiceScopeError(
      "GuiChu identity changed while the pending audio was being protected."
    );
  }
}

/**
 * Identity gate around a host-provided encryption primitive. It rejects a
 * pending recording after an account identity change while still allowing
 * recovery after ordinary conversation or tab navigation.
 */
export function createGuichuOutboxCodec<SealedPayload>(
  options: GuichuOutboxCodecOptions<SealedPayload>
): DirectAudioOutboxCodec<GuichuSealedOutboxEnvelope<SealedPayload>> {
  return {
    async encode(record) {
      const context = options.context();
      const bindingTag = await options.bindingTag(context);
      assertIdentityUnchanged(options.context, context);
      const sealed = await options.seal({ record, ...context });
      assertIdentityUnchanged(options.context, context);
      return {
        bindingTag,
        sealed
      };
    },
    async decode(envelope) {
      const context = options.context();
      const bindingTag = await options.bindingTag(context);
      assertIdentityUnchanged(options.context, context);
      if (envelope.bindingTag !== bindingTag) {
        throw new Error("Pending audio belongs to a different GuiChu identity context.");
      }
      const record = await options.open({ sealed: envelope.sealed, ...context });
      assertIdentityUnchanged(options.context, context);
      return record;
    }
  };
}
