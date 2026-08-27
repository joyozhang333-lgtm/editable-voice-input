export interface MergeTranscriptOptions {
  strategy?: "append" | "replace";
  separator?: string;
}

export function mergeTranscriptDraft(
  existing: string,
  transcript: string,
  options: MergeTranscriptOptions = {}
): string {
  const next = transcript.trim();
  if (!next) return existing;
  if (options.strategy === "replace" || !existing.trim()) return next;

  const separator = options.separator ?? "\n";
  const trimmedExisting = existing.trimEnd();
  const existingWhitespace = existing.slice(trimmedExisting.length);
  if (existingWhitespace) return `${trimmedExisting}${existingWhitespace}${next}`;
  return `${trimmedExisting}${separator}${next}`;
}

export function transcriptionText(result: string | { text: string }): string {
  return typeof result === "string" ? result : result.text;
}
