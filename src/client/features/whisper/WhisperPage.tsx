import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import {
  useMutationWithInvalidation,
  useSettingsQuery,
  useSSE,
  useTranscriptionHealthQuery,
  useTranscriptionHistoryQuery,
} from "../../hooks";
import type { ScannedFile, TranscriptionHistoryEntry } from "../../types";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

type OutputFormat = "srt" | "ass" | "vtt" | "txt";
const FORMATS: OutputFormat[] = ["srt", "ass", "vtt", "txt"];
const FALLBACK_MODELS = ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3", "distil-large-v3", "large-v3-turbo"];
const COMMON_LANGS = ["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"];
// CTranslate2 compute types are device-specific: float16 / int8_float16 are
// GPU-only and crash on CPU. Gate the selector by device so an invalid pair can
// never be chosen (keeps it simple + error-free). int8 is valid everywhere.
const COMPUTE_BY_DEVICE: Record<string, string[]> = {
  cpu: ["int8", "float32"],
  cuda: ["int8", "int8_float16", "float16", "float32"],
};

interface FileProgress { pct?: number; done?: boolean; error?: boolean; cancelled?: boolean; phase?: string }

interface TreeNode {
  name: string;
  path: string;          // folder path key (relative)
  children: TreeNode[];
  files: ScannedFile[];  // files directly in this folder
  allPaths: string[];    // every videoPath under this node (recursive)
}

// Split a videoPath into folder segments + filename, relative to the media root.
function relSegments(videoPath: string): string[] {
  const marker = "/media/";
  const idx = videoPath.indexOf(marker);
  const rest = idx >= 0 ? videoPath.slice(idx + marker.length) : videoPath.replace(/^\/+/, "");
  return rest.split(/[\\/]/).filter(Boolean);
}

function buildFolderTree(files: ScannedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], files: [], allPaths: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const f of files) {
    const segs = relSegments(f.videoPath as string);
    const dirs = segs.slice(0, -1);
    let node = root;
    let acc = "";
    for (const dir of dirs) {
      acc = acc ? `${acc}/${dir}` : dir;
      let child = byPath.get(acc);
      if (!child) {
        child = { name: dir, path: acc, children: [], files: [], allPaths: [] };
        byPath.set(acc, child);
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }
  const fill = (n: TreeNode): string[] => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => (a.videoName || "").localeCompare(b.videoName || ""));
    const own = n.files.map((f) => f.videoPath as string);
    const kids = n.children.flatMap(fill);
    n.allPaths = [...own, ...kids];
    return n.allPaths;
  };
  fill(root);
  return root;
}

export function WhisperPage({ isMobile = false }: { isMobile?: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const settingsQuery = useSettingsQuery();
  const settings = (settingsQuery.data ?? {}) as Record<string, unknown>;
  const backendConfigured = Boolean(str(settings.transcription_backend_url));
  const enabled = str(settings.transcription_enabled, "0") === "1";

  const healthQuery = useTranscriptionHealthQuery(backendConfigured);
  const historyQuery = useTranscriptionHistoryQuery(true, 20);
  const attempts = historyQuery.data?.attempts ?? [];
  const caps = healthQuery.data?.health?.capabilities;

  const retryMutation = useMutationWithInvalidation((id: string) => api.retryTranscriptionAttempt(id));
  const onRetry = (attempt: TranscriptionHistoryEntry) => retryMutation.mutate(attempt.id);

  // Library file list (non-mutating preview scan of MEDIA_DIR).
  const scanQuery = useQuery({
    queryKey: ["whisper-library"],
    queryFn: ({ signal }) => api.previewScan({ signal }),
    enabled: enabled && backendConfigured,
  });
  const videoFiles: ScannedFile[] = useMemo(
    () => (scanQuery.data?.files ?? []).filter((f) => Boolean(f.videoPath)),
    [scanQuery.data],
  );
  // Build a navigable folder tree from the file paths so subfolders can be
  // expanded and selected individually (not collapsed into one top-level group).
  const tree = useMemo(() => buildFolderTree(videoFiles), [videoFiles]);

  // Per-run options (default from Settings + advertised capabilities).
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [computeType, setComputeType] = useState("");
  const [language, setLanguage] = useState("");
  const [format, setFormat] = useState<OutputFormat>("srt");
  const [diarize, setDiarize] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  // Diarization toggle is offered only when the backend advertises it (pyannote
  // installed + HF token configured), so it can never be a silent no-op.
  const canDiarize = Boolean(caps?.advancedOptions?.speakerDiarization);
  // URL/YouTube input offered only when the backend has yt-dlp installed.
  const canUrl = Boolean((caps as { urlInput?: boolean } | undefined)?.urlInput);
  const modelOptions = caps?.models?.length ? caps.models : FALLBACK_MODELS;
  const deviceOptions = caps?.devices?.length ? caps.devices : ["cpu"];
  const eff = (v: string, fallbackKey: string, fb: string) => v || str(settings[fallbackKey], fb);
  const effModel = eff(model, "transcription_model", "small");
  const effDevice = eff(device, "transcription_device", "cpu");
  const effLang = eff(language, "transcription_language", "auto");
  // Compute options follow the chosen device; the effective value is always a
  // member of that set (falls back to int8), so cpu+float16 can't be submitted.
  const computeOptions = COMPUTE_BY_DEVICE[effDevice] ?? ["int8"];
  const rawCompute = eff(computeType, "transcription_compute_type", "int8");
  const effCompute = computeOptions.includes(rawCompute) ? rawCompute : computeOptions[0];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const cancelRef = useRef(false);
  // Synchronous mirror of activePath so cancelBatch always targets the file the
  // loop is actually on (state can lag a render behind).
  const activePathRef = useRef<string | null>(null);

  // Default-expand the top-level folders when the tree (re)builds.
  useEffect(() => {
    setExpanded((prev) => (prev.size ? prev : new Set(tree.children.map((c) => c.path))));
  }, [tree]);
  const toggleExpand = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });

  // Drop stale selections when the library refetches (a file may be gone).
  useEffect(() => {
    const present = new Set(videoFiles.map((f) => f.videoPath as string));
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((p) => present.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [videoFiles]);

  // Live per-file progress from the server's SSE broadcast. Stable callback so
  // useSSE's ref-sync effect doesn't churn every render.
  useSSE(useCallback((type, data) => {
    if (type !== "transcription:progress") return;
    const d = data as { path?: string; pct?: number; done?: boolean; error?: boolean; cancelled?: boolean; phase?: string };
    if (!d.path) return;
    // Merge so a phase-only line (e.g. "diarizing") keeps the last pct.
    setFileProgress((prev) => {
      const cur = prev[d.path as string] || {};
      return {
        ...prev,
        [d.path as string]: {
          ...cur,
          ...(d.pct !== undefined ? { pct: d.pct } : {}),
          ...(d.done !== undefined ? { done: d.done } : {}),
          ...(d.error !== undefined ? { error: d.error } : {}),
          ...(d.cancelled !== undefined ? { cancelled: d.cancelled } : {}),
          ...(d.phase !== undefined ? { phase: d.phase } : {}),
        },
      };
    });
  }, []));

  const toggle = (vp: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vp)) next.delete(vp); else next.add(vp);
      return next;
    });
  const toggleFolder = (paths: string[]) => {
    const allSelected = paths.length > 0 && paths.every((p) => selected.has(p));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(videoFiles.map((f) => f.videoPath as string)));

  const cancelBatch = async () => {
    cancelRef.current = true;
    const target = activePathRef.current;
    if (target) {
      try { await api.cancelTranscription({ path: target }); } catch { /* best-effort */ }
    }
  };

  const transcribeSelected = async () => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    const withSubs = videoFiles.filter((f) => f.videoPath && selected.has(f.videoPath) && f.subtitles.length > 0);
    if (withSubs.length > 0) {
      const ok = await confirm({
        title: t("whisper.overwriteTitle"),
        message: t("whisper.overwriteConfirm", { count: withSubs.length }),
      });
      if (!ok) return;
    }
    setRunning(true);
    cancelRef.current = false;
    setFileProgress({});  // drop stale badges from a previous run
    setProgress({ done: 0, total: paths.length });
    let ok = 0;
    for (let i = 0; i < paths.length; i++) {
      if (cancelRef.current) break;
      activePathRef.current = paths[i];
      setActivePath(paths[i]);
      try {
        await api.transcribeVideo({
          videoPath: paths[i],
          outputFormat: format,
          postAction: "transcribe_only",
          model: effModel,
          language: effLang,
          device: effDevice,
          computeType: effCompute,
          speakerDiarization: canDiarize && diarize,
        });
        ok += 1;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "failed";
        if (!/cancelled/i.test(msg)) addToast(`${baseName(paths[i])}: ${msg}`, "error");
      }
      setProgress({ done: i + 1, total: paths.length });
    }
    activePathRef.current = null;
    setActivePath(null);
    setRunning(false);
    setProgress(null);
    setSelected(new Set());
    addToast(t("whisper.batchDone", { ok, total: paths.length, format: format.toUpperCase() }), ok > 0 ? "success" : "error");
    scanQuery.refetch();
    historyQuery.refetch();
  };

  const transcribeFromUrl = async () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlBusy(true);
    try {
      const res = await api.transcribeUrl({
        url, outputFormat: format, model: effModel, language: effLang,
        device: effDevice, computeType: effCompute, speakerDiarization: canDiarize && diarize,
      });
      // No local media file for a URL — hand the rendered subtitle to the browser.
      const blob = new Blob([res.content], { type: "text/plain;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      const safeExt = (FORMATS as string[]).includes(res.outputFormat) ? res.outputFormat : format;
      a.download = `transcript.${safeExt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      addToast(t("whisper.urlDone", { segments: res.segments ?? 0 }), "success");
      setUrlValue("");
    } catch (e: unknown) {
      addToast(`${t("whisper.urlFailed")}: ${e instanceof Error ? e.message : "failed"}`, "error");
    } finally {
      setUrlBusy(false);
    }
  };

  const selectCls = "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] text-[var(--text)]";

  return (
    <div className={`mx-auto w-full max-w-[1100px] space-y-4 ${isMobile ? "p-3 pb-24" : "p-5"}`}>
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">{t("whisper.title")}</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">{t("whisper.subtitle")}</p>
      </div>

      {!enabled && (
        <div className="rounded-2xl border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-4 py-3 text-[13px] text-[var(--yellow)]">
          {t("whisper.disabledNotice")} <Link to="/settings" className="underline">{t("whisper.openSettings")}</Link>
        </div>
      )}

      {enabled && backendConfigured && (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
          <div>
            <h2 className="text-[13.5px] font-semibold text-[var(--text)]">{t("whisper.pickerTitle")}</h2>
            <p className="text-[11px] text-[var(--text-3)]">{t("whisper.pickerHint")}</p>
          </div>

          {/* Per-run options */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.model")}
              <select value={effModel} onChange={(e) => setModel(e.target.value)} className={selectCls}>
                {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.device")}
              <select value={effDevice} onChange={(e) => setDevice(e.target.value)} className={selectCls}>
                {deviceOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.compute")}
              <select value={effCompute} onChange={(e) => setComputeType(e.target.value)} className={selectCls}>
                {computeOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.language")}
              <select value={effLang} onChange={(e) => setLanguage(e.target.value)} className={selectCls}>
                {COMMON_LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.format")}
              <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)} className={selectCls}>
                {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </label>
            {canDiarize ? (
              <label className="flex items-center gap-2 text-[11px] text-[var(--text-2)]">
                <input type="checkbox" checked={diarize} onChange={(e) => setDiarize(e.target.checked)} className="h-4 w-4 accent-blue-500" />
                {t("whisper.diarize")}
              </label>
            ) : caps ? (
              <label className="flex items-center gap-2 text-[11px] text-[var(--text-3)] opacity-60" title={t("whisper.diarizeUnavailable")}>
                <input type="checkbox" disabled className="h-4 w-4" />
                {t("whisper.diarize")}
              </label>
            ) : null}
          </div>

          {/* URL / YouTube input (only when backend has yt-dlp) */}
          {canUrl && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="url"
                aria-label={t("whisper.urlPlaceholder")}
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                placeholder={t("whisper.urlPlaceholder")}
                className={`${selectCls} min-w-[280px] flex-1`}
              />
              <button type="button" disabled={urlBusy || !urlValue.trim()} onClick={transcribeFromUrl}
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
                {urlBusy ? t("whisper.urlBusy") : t("whisper.urlButton")}
              </button>
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={running || selected.size === 0} onClick={transcribeSelected}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
              {running && progress ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total }) : t("whisper.transcribeSelected", { count: selected.size })}
            </button>
            {running && (
              <button type="button" onClick={cancelBatch}
                className="rounded-lg border border-red-700/60 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-300">
                {t("whisper.cancel")}
              </button>
            )}
            <button type="button" onClick={selectAll} disabled={running || videoFiles.length === 0}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)] disabled:opacity-40">
              {t("whisper.selectAll")}
            </button>
            <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)] disabled:opacity-40">
              {t("whisper.clear")}
            </button>
            <button type="button" onClick={() => scanQuery.refetch()} disabled={scanQuery.isFetching}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)]">
              {scanQuery.isFetching ? t("whisper.scanning") : t("whisper.rescan")}
            </button>
          </div>

          <div className="mt-3 max-h-[40vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {scanQuery.isLoading && <div className="px-4 py-6 text-center text-xs text-[var(--text-3)]">{t("whisper.scanning")}</div>}
            {!scanQuery.isLoading && videoFiles.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-3)]">{t("whisper.noVideos")}</div>
            )}
            {!scanQuery.isLoading && tree.children.map((child) => (
              <FolderNodeView
                key={child.path}
                node={child}
                depth={0}
                selected={selected}
                expanded={expanded}
                toggleExpand={toggleExpand}
                toggleFolder={toggleFolder}
                toggleFile={toggle}
                fileProgress={fileProgress}
                activePath={activePath}
              />
            ))}
            {/* Files directly in the media root (no subfolder). */}
            {!scanQuery.isLoading && tree.files.map((f) => (
              <FileRow key={f.videoPath as string} file={f} depth={0} selected={selected} toggleFile={toggle} fileProgress={fileProgress} activePath={activePath} />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-[var(--text-3)]">{t("whisper.overwriteHint")}</p>
        </section>
      )}

      {/* Readiness + Model Manager live in Settings → Speech to Text; the Whisper
          page focuses on picking files and transcribing. */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
        <TranscriptionHistoryPanel attempts={attempts} transcribingPath={activePath} isRetryPending={retryMutation.isPending} isTranscribePending={running} onRetry={onRetry} />
      </section>
    </div>
  );
}

interface FileRowProps {
  file: ScannedFile;
  depth: number;
  selected: Set<string>;
  toggleFile: (vp: string) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
}

function FileRow({ file, depth, selected, toggleFile, fileProgress, activePath }: FileRowProps) {
  const { t } = useTranslation();
  const vp = file.videoPath as string;
  const fp = fileProgress[vp];
  const status = fp?.done ? t("whisper.statusDone")
    : fp?.cancelled ? t("whisper.statusCancelled")
    : fp?.error ? t("whisper.statusError")
    : fp?.phase === "diarizing" ? t("whisper.diarizing")
    : typeof fp?.pct === "number" ? `${Math.round(fp.pct)}%` : "";
  return (
    <label className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
      style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}>
      <input type="checkbox" checked={selected.has(vp)} onChange={() => toggleFile(vp)} className="h-4 w-4 accent-blue-500" />
      <span className="truncate">🎬 {file.videoName || baseName(vp)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {status && <span className={`text-[10px] ${activePath === vp ? "text-[var(--accent)]" : "text-[var(--text-3)]"}`}>{status}</span>}
        {file.subtitles.length > 0 && <span className="text-[10px] text-[var(--text-3)]">{t("whisper.hasSubtitle")}</span>}
      </span>
    </label>
  );
}

interface FolderNodeProps {
  node: TreeNode;
  depth: number;
  selected: Set<string>;
  expanded: Set<string>;
  toggleExpand: (p: string) => void;
  toggleFolder: (paths: string[]) => void;
  toggleFile: (vp: string) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
}

function FolderNodeView(props: FolderNodeProps) {
  const { node, depth, selected, expanded, toggleExpand, toggleFolder } = props;
  const open = expanded.has(node.path);
  const allSel = node.allPaths.length > 0 && node.allPaths.every((p) => selected.has(p));
  const someSel = !allSel && node.allPaths.some((p) => selected.has(p));
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] font-medium text-[var(--text)]"
        style={{ paddingLeft: `${12 + depth * 16}px` }}>
        <button type="button" onClick={() => toggleExpand(node.path)} className="w-3 shrink-0 text-[var(--text-3)]" aria-label={node.name} aria-expanded={open}>
          {open ? "▾" : "▸"}
        </button>
        <input
          type="checkbox"
          aria-label={node.name}
          checked={allSel}
          ref={(el) => { if (el) el.indeterminate = someSel; }}
          onChange={() => toggleFolder(node.allPaths)}
          className="h-4 w-4 accent-blue-500"
        />
        <button type="button" onClick={() => toggleExpand(node.path)} className="flex-1 truncate text-left">
          📁 {node.name} <span className="text-[10px] text-[var(--text-3)]">({node.allPaths.length})</span>
        </button>
      </div>
      {open && (
        <>
          {node.children.map((c) => <FolderNodeView key={c.path} {...props} node={c} depth={depth + 1} />)}
          {node.files.map((f) => (
            <FileRow key={f.videoPath as string} file={f} depth={depth} selected={selected} toggleFile={props.toggleFile} fileProgress={props.fileProgress} activePath={props.activePath} />
          ))}
        </>
      )}
    </div>
  );
}
