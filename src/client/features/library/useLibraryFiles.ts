import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { LIBRARY_QUERY_KEY, useMutationWithInvalidation } from "../../hooks";
import { useToast } from "../../ui/Toast";
import type { Job, ScanResult, TaskStatus } from "../../types";
import type { UseManualTranscriptionResult } from "../dashboard/useManualTranscription";
import type { JobStatusFilter } from "./dashboard-params";
import { fileRowMatches, fileRows, fileRowTarget, type FileRow } from "./file-rows";
import type { FileRowActions } from "./FileRows";
import type { LibraryItem } from "./library-model";
import { withQueuedTask } from "./task-status";

interface LibraryFilesInput {
  items: LibraryItem[];
  jobsById: Map<number, Job>;
  status: JobStatusFilter;
  query: string;
  folderFilter: string;
  targetFilter: string;
  /** The folder filter's name for the media root itself. */
  rootLabel: string;
  transcription: UseManualTranscriptionResult;
  transcriptionEnabled: boolean;
}

const KIND_FOR_STATUS: Partial<Record<JobStatusFilter, FileRow["kind"]>> = {
  needsTranscription: "untranscribed",
  notQueued: "unqueued",
};

/**
 * The Library files the Jobs view lists beside the jobs (see file-rows.ts):
 * the rows the filters leave visible, their counts and folders, their
 * actions, and which file's panel is open.
 */
export function useLibraryFiles({
  items,
  jobsById,
  status,
  query,
  folderFilter,
  targetFilter,
  rootLabel,
  transcription,
  transcriptionEnabled,
}: LibraryFilesInput) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const translateMutation = useMutationWithInvalidation(api.translateFile);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The subtitle whose "Translate to…" form the panel opens; id changes per request.
  const [translateRequest, setTranslateRequest] = useState<{ srtPath: string; id: number } | null>(null);
  const requestTranslate = useCallback(
    (srtPath: string) => setTranslateRequest((prev) => ({ srtPath, id: (prev?.id ?? 0) + 1 })),
    [],
  );

  const all = useMemo(() => fileRows(items, jobsById), [items, jobsById]);
  const counts = useMemo(
    () => ({
      untranscribed: all.filter((row) => row.kind === "untranscribed").length,
      unqueued: all.filter((row) => row.kind === "unqueued").length,
    }),
    [all],
  );
  const folders = useMemo(() => all.map((row) => row.folder || rootLabel), [all, rootLabel]);
  const targets = useMemo(() => all.flatMap((row) => fileRowTarget(row) ?? []), [all]);
  const visible = useMemo(() => {
    const kind = KIND_FOR_STATUS[status];
    if (status !== "all" && !kind) return [];
    return all.filter((row) => {
      if (kind && row.kind !== kind) return false;
      if (targetFilter !== "all" && fileRowTarget(row) !== targetFilter) return false;
      return fileRowMatches(row, query, folderFilter, rootLabel);
    });
  }, [all, status, targetFilter, query, folderFilter, rootLabel]);

  const handleQueued = useCallback(
    (srtPath: string, task: TaskStatus) => {
      queryClient.setQueryData<ScanResult>(
        LIBRARY_QUERY_KEY,
        (prev) => prev && { ...prev, files: withQueuedTask(prev.files, srtPath, task) },
      );
    },
    [queryClient],
  );

  const translate = useCallback(
    async (row: FileRow) => {
      if (row.kind !== "unqueued") return;
      try {
        const result = await translateMutation.mutateAsync({ srtPath: row.path, taskId: row.task.taskId });
        handleQueued(row.path, { ...row.task, status: "pending", jobId: result.jobId });
        addToast(
          t(result.created ? "scan.translateFile.queued" : "scan.translateFile.alreadyQueued", {
            lang: row.task.targetLang,
          }),
          result.created ? "success" : "info",
        );
      } catch (e) {
        addToast(getErrorMessage(e), "error");
      }
    },
    [translateMutation, handleQueued, addToast, t],
  );

  const actions: FileRowActions = useMemo(
    () => ({
      onOpen: (row) => {
        setTranslateRequest(null);
        setOpenKey(row.item.key);
      },
      onTranslateTo: (row) => {
        requestTranslate(row.path);
        setOpenKey(row.item.key);
      },
      onTranslate: (row) => void translate(row),
      // The panel's main Transcribe button does the same: transcribe, then translate.
      onTranscribe: transcriptionEnabled
        ? (row) => void transcription.handleTranscribe(row.path, "transcribe_and_translate")
        : undefined,
    }),
    [translate, transcription, transcriptionEnabled, requestTranslate],
  );

  /**
   * Opens the panel of the file a job translates, with its "Translate to…"
   * form when `translate`; false when no Library file holds it (a Convert upload).
   */
  const openJobFile = useCallback(
    (job: Job, translate = false) => {
      const item = items.find((entry) => entry.file.subtitles.some((sub) => sub.srtPath === job.srt_path));
      if (item) {
        if (translate) requestTranslate(job.srt_path);
        else setTranslateRequest(null);
        setOpenKey(item.key);
      }
      return item !== undefined;
    },
    [items, requestTranslate],
  );

  const openItem = openKey === null ? undefined : items.find((item) => item.key === openKey);
  return {
    visible,
    counts,
    folders,
    targets,
    actions,
    openItem,
    openJobFile,
    openFileKey: (key: string) => {
      setTranslateRequest(null);
      setOpenKey(key);
    },
    translateRequest,
    closePanel: () => {
      setOpenKey(null);
      setTranslateRequest(null);
    },
    handleQueued,
  };
}
