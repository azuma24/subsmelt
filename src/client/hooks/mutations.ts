import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import { useSSE } from "./sse";

export function useInvalidateApp() {
  const queryClient = useQueryClient();
  return useMemo(
    () => () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
      queryClient.invalidateQueries({ queryKey: ["transcription-history"] });
      queryClient.invalidateQueries({ queryKey: ["library"] });
    },
    [queryClient]
  );
}

export function useMutationWithInvalidation<TData = unknown, TVars = void>(
  fn: (vars: TVars) => Promise<TData>
) {
  const invalidate = useInvalidateApp();
  return useMutation({ mutationFn: fn, onSuccess: invalidate });
}

// Per-model download progress state returned by useModelDownload.
export interface ModelDownloadProgress {
  active: boolean;
  pct: number;
}

/**
 * Returns the live download-progress map (keyed by model id) plus a
 * `downloadModel` function that kicks off a download, streams progress via
 * SSE, invalidates the models query on completion, and resolves when done.
 * Shared by the Whisper page and the Settings model manager so both follow
 * the same clearing rule.
 */
export function useModelDownload() {
  const queryClient = useQueryClient();
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadProgress>>({});

  // Listen for model:download SSE events and update progress state.
  // NOTE: we intentionally do NOT delete the entry on error/done here — the
  // downloadModel finally block is the single authoritative place that clears
  // the entry once the HTTP promise settles. Deleting here while the HTTP call
  // is still in flight would allow a second parallel download to start because
  // the active guard would see no entry. Only pct updates are applied via SSE.
  useSSE(
    useCallback((type, data) => {
      if (type !== "model:download") return;
      const model = typeof data.model === "string" ? data.model : "";
      if (!model) return;
      if (typeof data.pct === "number") {
        const pct = Math.max(0, Math.min(100, data.pct));
        setDownloads((prev) => {
          // Only update if the entry already exists (i.e. the HTTP call is active);
          // ignore stray SSE events that arrive after the entry was cleared.
          if (!prev[model]) return prev;
          return { ...prev, [model]: { active: true, pct } };
        });
      }
    }, []),
  );

  /**
   * Starts a model download and waits for it to finish (or throw).
   * Invalidates ["whisper-models"] after a successful download.
   */
  const downloadModel = useCallback(async (model: string): Promise<void> => {
    setDownloads((prev) => ({ ...prev, [model]: { active: true, pct: prev[model]?.pct ?? 0 } }));
    try {
      await api.downloadWhisperModel(model);
      await queryClient.invalidateQueries({ queryKey: ["whisper-models"] });
    } finally {
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model];
        return next;
      });
    }
  }, [queryClient]);

  return { downloads, downloadModel };
}
