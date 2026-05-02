export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
}

export interface CopyTextResult {
  ok: boolean;
  error?: string;
}

export async function copyText(
  text: string,
  deps: { clipboard?: ClipboardLike } = { clipboard: globalThis.navigator?.clipboard },
): Promise<CopyTextResult> {
  if (!deps.clipboard?.writeText) {
    return { ok: false, error: "Clipboard unavailable" };
  }

  try {
    await deps.clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Clipboard write failed",
    };
  }
}
