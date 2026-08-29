import type {
  DictationProvider,
  DictationProviderSession,
  DictationProviderStartInput
} from "./dictation";
import { VoiceInputError } from "./types";

export interface WebSpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

export interface WebSpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: WebSpeechRecognitionAlternativeLike;
  item?(index: number): WebSpeechRecognitionAlternativeLike;
}

export interface WebSpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: WebSpeechRecognitionResultLike;
  item?(index: number): WebSpeechRecognitionResultLike;
}

export interface WebSpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: WebSpeechRecognitionResultListLike;
}

export interface WebSpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

export interface WebSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: WebSpeechRecognitionEventLike) => void) | null;
  onerror: ((event: WebSpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface WebSpeechRecognitionConstructor {
  new (): WebSpeechRecognitionLike;
}

export interface BrowserWebSpeechDictationProviderOptions {
  RecognitionConstructor?: WebSpeechRecognitionConstructor;
  continuous?: boolean;
  interimResults?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function browserRecognitionConstructor(): WebSpeechRecognitionConstructor | undefined {
  const speechGlobal = globalThis as typeof globalThis & {
    SpeechRecognition?: WebSpeechRecognitionConstructor;
    webkitSpeechRecognition?: WebSpeechRecognitionConstructor;
  };
  return speechGlobal.SpeechRecognition ?? speechGlobal.webkitSpeechRecognition;
}

function mapWebSpeechError(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  const code =
    typeof error === "object" && error !== null && "error" in error
      ? String(error.error)
      : "";
  if (code === "not-allowed" || code === "service-not-allowed") {
    return new VoiceInputError("permission-denied", "Speech recognition permission was denied.", {
      cause: error
    });
  }
  if (code === "audio-capture") {
    return new VoiceInputError(
      "device-unavailable",
      "No usable microphone is available for speech recognition.",
      { cause: error }
    );
  }
  if (code === "aborted") {
    return new VoiceInputError("capture-cancelled", "Speech recognition was cancelled.", {
      cause: error
    });
  }
  return new VoiceInputError("transcription-failed", "Live speech recognition failed.", {
    cause: error
  });
}

function resultAt(
  results: WebSpeechRecognitionResultListLike,
  index: number
): WebSpeechRecognitionResultLike | undefined {
  return results[index] ?? results.item?.(index);
}

function alternativeAt(
  result: WebSpeechRecognitionResultLike,
  index: number
): WebSpeechRecognitionAlternativeLike | undefined {
  return result[index] ?? result.item?.(index);
}

class BrowserWebSpeechDictationSession implements DictationProviderSession {
  private readonly recognition: WebSpeechRecognitionLike;
  private readonly input: DictationProviderStartInput;
  private readonly completion = deferred<void>();
  private readonly finalizedIndexes = new Set<number>();
  private settled = false;
  private cancelled = false;

  constructor(
    RecognitionConstructor: WebSpeechRecognitionConstructor,
    input: DictationProviderStartInput,
    options: BrowserWebSpeechDictationProviderOptions
  ) {
    this.recognition = new RecognitionConstructor();
    this.input = input;
    this.recognition.continuous = options.continuous ?? true;
    this.recognition.interimResults = options.interimResults ?? true;
    if (input.language) this.recognition.lang = input.language;
    this.recognition.onresult = this.handleResult;
    this.recognition.onerror = this.handleError;
    this.recognition.onend = this.handleEnd;
    input.signal?.addEventListener("abort", this.handleAbort, { once: true });
  }

  get result(): Promise<void> {
    return this.completion.promise;
  }

  get active(): boolean {
    return !this.settled;
  }

  begin(): void {
    if (this.input.signal?.aborted) {
      this.cleanup();
      throw new VoiceInputError("capture-cancelled", "Speech recognition was cancelled.");
    }
    try {
      this.recognition.start();
    } catch (error) {
      this.cleanup();
      throw mapWebSpeechError(error);
    }
  }

  stop(): Promise<void> {
    if (this.settled) return this.result;
    try {
      this.recognition.stop();
    } catch (error) {
      this.reject(mapWebSpeechError(error));
    }
    return this.result;
  }

  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    try {
      this.recognition.abort();
    } catch {
      // Cancellation is terminal even when a browser throws while aborting.
    }
    this.reject(new VoiceInputError("capture-cancelled", "Speech recognition was cancelled."));
  }

  private readonly handleResult = (event: WebSpeechRecognitionEventLike): void => {
    if (this.settled) return;
    const interim: string[] = [];

    for (let index = 0; index < event.results.length; index += 1) {
      const result = resultAt(event.results, index);
      const alternative = result ? alternativeAt(result, 0) : undefined;
      const transcript = alternative?.transcript.trim() ?? "";
      if (!result || !transcript) continue;

      if (result.isFinal) {
        if (index < event.resultIndex || this.finalizedIndexes.has(index)) continue;
        this.finalizedIndexes.add(index);
        this.input.onResult({
          transcript,
          isFinal: true,
          ...(typeof alternative?.confidence === "number" &&
          Number.isFinite(alternative.confidence)
            ? { confidence: alternative.confidence }
            : {})
        });
      } else {
        interim.push(transcript);
      }
    }

    this.input.onResult({ transcript: interim.join(" "), isFinal: false });
  };

  private readonly handleError = (event: WebSpeechRecognitionErrorEventLike): void => {
    if (this.settled) return;
    if (this.cancelled || event.error === "aborted") {
      this.reject(new VoiceInputError("capture-cancelled", "Speech recognition was cancelled."));
      return;
    }
    this.reject(mapWebSpeechError(event));
  };

  private readonly handleEnd = (): void => {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.completion.resolve(undefined);
  };

  private readonly handleAbort = (): void => {
    this.cancel();
  };

  private reject(error: VoiceInputError): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.completion.reject(error);
  }

  private cleanup(): void {
    this.input.signal?.removeEventListener("abort", this.handleAbort);
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
  }
}

export class BrowserWebSpeechDictationProvider implements DictationProvider {
  private readonly options: BrowserWebSpeechDictationProviderOptions;

  constructor(options: BrowserWebSpeechDictationProviderOptions = {}) {
    this.options = options;
  }

  async start(input: DictationProviderStartInput): Promise<DictationProviderSession> {
    const RecognitionConstructor =
      this.options.RecognitionConstructor ?? browserRecognitionConstructor();
    if (!RecognitionConstructor) {
      throw new VoiceInputError(
        "unsupported-browser",
        "This browser does not provide the Web Speech recognition API."
      );
    }
    const session = new BrowserWebSpeechDictationSession(
      RecognitionConstructor,
      input,
      this.options
    );
    session.begin();
    return session;
  }
}

export function isBrowserWebSpeechDictationSupported(): boolean {
  return Boolean(browserRecognitionConstructor());
}
