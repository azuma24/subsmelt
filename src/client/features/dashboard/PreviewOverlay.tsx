import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useJobPreview } from "../../hooks";
import { formatTimecode } from "../../lib";
import { copyText } from "../../lib/clipboard";
import { ModalShell } from "../../components/ModalShell";
import { PageError, PageLoading } from "../../ui/QueryState";
import { useToast } from "../../components/Toast";
import { ApiError, jobDownloadUrl, saveJobCues } from "../../api";
import type { PreviewLine } from "../../types";

interface PreviewOverlayProps {
  isMobile: boolean;
  jobId: number;
  previewSearch: string;
  setPreviewSearch: (v: string) => void;
  onClose: () => void;
}

function splitAnalysisSections(analysis: string) {
  const plotMatch = analysis.match(/###\s*📝\s*Plot Summary([\s\S]*?)###\s*📚\s*Glossary/i);
  const glossaryMatch = analysis.match(/###\s*📚\s*Glossary([\s\S]*)$/i);
  const plot = plotMatch?.[1]?.trim() || "";
  const glossary = glossaryMatch?.[1]?.trim() || "";
  return { plot, glossary };
}

// Above this many cue rows we window the list; below it we render the list
// fully so small/filtered previews keep simple, fully-mounted behavior.
// Mirrors the VIRTUALIZE_THRESHOLD used by JobsTableDesktop.
const VIRTUALIZE_THRESHOLD = 200;
// Initial per-row height estimates (px). react-virtual measures real heights,
// so these only seed the first paint. Desktop rows are tight; mobile cards taller.
const DESKTOP_ROW_ESTIMATE = 40;
const MOBILE_ROW_ESTIMATE = 150;
// Shared grid template for the virtualized desktop rows so the windowed body
// stays column-aligned with the sticky header: # | TIME | ORIGINAL | TRANSLATED | ⚠
const DESKTOP_GRID_COLS = "32px 96px minmax(0,1fr) minmax(0,1fr) 32px";

/**
 * Shared edit context threaded through every render path (table / list /
 * virtualized). Edits live in a Map keyed by the STABLE cue index (line.index),
 * never by row position, so the windowed list and filters stay correct.
 */
interface EditCtx {
  // Current edited value for a cue index, or undefined if unedited.
  getValue: (index: number) => string | undefined;
  // True when the cue's current value differs from the saved baseline.
  isDirty: (index: number) => boolean;
  onChange: (index: number, value: string) => void;
  placeholder: string;
  editedLabel: string;
}

export function PreviewOverlay({ isMobile, jobId, previewSearch, setPreviewSearch, onClose }: PreviewOverlayProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const previewQuery = useJobPreview(jobId);
  const previewData = previewQuery.data;
  const [showOnlyChanged, setShowOnlyChanged] = useState(false);
  const [showOnlyIssues, setShowOnlyIssues] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Pending edits keyed by stable cue index → new translated text. Cleared on
  // successful save (baseline is then refetched so highlights reflect saves).
  const [edits, setEdits] = useState<Map<number, string>>(new Map());

  // Baseline translated text per cue index from the server. Used to decide
  // whether an edit actually differs from what's saved on disk.
  const baseline = useMemo(() => {
    const map = new Map<number, string>();
    for (const line of previewData?.lines || []) map.set(line.index, line.translated || "");
    return map;
  }, [previewData?.lines]);

  // Reset edit buffer when switching jobs or when fresh data arrives.
  useEffect(() => {
    setEdits(new Map());
  }, [jobId]);

  // Outer scroll viewport. Holds the analysis block + the (possibly windowed)
  // cue list, so existing scroll behavior (analysis scrolls with the list) is
  // preserved. When the list is windowed it is also the virtualizer's scroller.
  const listRef = useRef<HTMLDivElement>(null);
  // Marks where the cue list begins inside the scroll viewport so the
  // virtualizer can offset for the analysis block rendered above it.
  const listStartRef = useRef<HTMLDivElement>(null);

  const { plot, glossary } = useMemo(() => splitAnalysisSections(previewData?.analysis || ""), [previewData?.analysis]);

  const getValue = useCallback(
    (index: number): string | undefined => edits.get(index),
    [edits]
  );
  const isDirty = useCallback(
    (index: number): boolean => {
      if (!edits.has(index)) return false;
      return (edits.get(index) ?? "") !== (baseline.get(index) ?? "");
    },
    [edits, baseline]
  );
  const onChange = useCallback((index: number, value: string) => {
    setEdits((prev) => {
      const next = new Map(prev);
      next.set(index, value);
      return next;
    });
  }, []);

  const editCtx: EditCtx = useMemo(
    () => ({
      getValue,
      isDirty,
      onChange,
      placeholder: t("dashboard.preview.editPlaceholder"),
      editedLabel: t("dashboard.preview.edited"),
    }),
    [getValue, isDirty, onChange, t]
  );

  // The effective translated text for a line: edited value if present, else
  // the server baseline. Drives filters, issue detection, and Copy TSV so they
  // always reflect what the user currently sees.
  const effectiveTranslated = useCallback(
    (line: PreviewLine): string => {
      const edited = edits.get(line.index);
      return edited !== undefined ? edited : line.translated;
    },
    [edits]
  );

  // Count of cues whose edited value differs from the saved baseline.
  const dirtyCount = useMemo(() => {
    let n = 0;
    for (const [index, value] of edits) {
      if ((value ?? "") !== (baseline.get(index) ?? "")) n++;
    }
    return n;
  }, [edits, baseline]);

  const filteredLines = useMemo(() => {
    let lines = filterLines(previewData?.lines || [], previewSearch, effectiveTranslated);
    if (showOnlyChanged) lines = lines.filter((l) => l.original.trim() !== effectiveTranslated(l).trim());
    if (showOnlyIssues) lines = lines.filter((l) => hasIssue(l, effectiveTranslated(l)));
    return lines;
  }, [previewData?.lines, previewSearch, showOnlyChanged, showOnlyIssues, effectiveTranslated]);

  const shouldVirtualize = filteredLines.length > VIRTUALIZE_THRESHOLD;

  // Single virtualizer instance, scoped to the outer viewport. Created
  // unconditionally (hooks rules) but only consumed on the windowed path.
  const virtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => (isMobile ? MOBILE_ROW_ESTIMATE : DESKTOP_ROW_ESTIMATE),
    overscan: 12,
    scrollMargin: listStartRef.current?.offsetTop ?? 0,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const jumpToNextIssue = () => {
    const issueIdx = filteredLines.findIndex((line) => hasIssue(line, effectiveTranslated(line)));
    if (issueIdx === -1) {
      addToast(t("dashboard.preview.noIssues"), "info");
      return;
    }
    // When windowed the target row may not be mounted, so scroll the
    // virtualizer to it; otherwise the row exists in the DOM by its id.
    if (shouldVirtualize && virtualizerRef.current) {
      virtualizerRef.current.scrollToIndex(issueIdx, { align: "center", behavior: "smooth" });
      return;
    }
    const el = document.getElementById(`preview-line-${filteredLines[issueIdx].index}`);
    if (el && listRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const handleCopy = async (text: string, successMessage: string) => {
    const result = await copyText(text);
    if (result.ok) {
      addToast(successMessage, "success");
      return;
    }
    addToast(t("dashboard.preview.copyFailed"), "error");
  };

  const handleSave = async () => {
    // Only send cues that actually differ from the saved baseline.
    const payload: { index: number; text: string }[] = [];
    for (const [index, value] of edits) {
      if ((value ?? "") !== (baseline.get(index) ?? "")) payload.push({ index, text: value });
    }
    if (payload.length === 0) return;
    setIsSaving(true);
    try {
      const res = await saveJobCues(jobId, payload);
      addToast(t("dashboard.preview.saved", { count: res.updated }), "success");
      // Clear the edit buffer and refetch so the baseline reflects the saved
      // state — "changed" highlighting then turns off for the saved lines.
      setEdits(new Map());
      await previewQuery.refetch();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t("dashboard.preview.saveFailed");
      addToast(message, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const title = previewData?.srtPath?.split("/").pop() || t("dashboard.action.preview");

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 bg-black/70 p-0 md:p-4"
      panelClassName={`mx-auto flex h-full w-full flex-col overflow-hidden border border-gray-700 bg-gray-900 ${isMobile ? "rounded-none" : "max-w-6xl rounded-3xl md:max-h-[90vh]"}`}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-gray-800 px-5 py-4">
          <div className="min-w-0">
            {previewData?.targetLang && <p className="text-xs text-gray-500">→ {previewData.targetLang} • {filteredLines.length}</p>}
          </div>
          <input
            type="search"
            value={previewSearch}
            onChange={(e) => setPreviewSearch(e.target.value)}
            placeholder={t("dashboard.preview.search")}
            aria-label={t("dashboard.preview.search")}
            className="w-40 rounded-xl border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 md:w-56"
          />
          <button onClick={onClose} aria-label={t("common.close")} className="text-lg text-gray-400 hover:text-white">×</button>
        </div>
          <div className="border-b border-gray-800 px-4 py-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <button onClick={() => setShowOnlyChanged((v) => !v)} className={`rounded-lg px-2 py-1 ${showOnlyChanged ? "bg-blue-700 text-white" : "bg-gray-800 text-gray-300"}`}>{t("dashboard.preview.showOnlyChanged")}</button>
              <button onClick={() => setShowOnlyIssues((v) => !v)} className={`rounded-lg px-2 py-1 ${showOnlyIssues ? "bg-yellow-700 text-white" : "bg-gray-800 text-gray-300"}`}>{t("dashboard.preview.showOnlyIssues")}</button>
              <button onClick={jumpToNextIssue} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-300">{t("dashboard.preview.nextIssue")}</button>
            </div>
          </div>
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {previewQuery.isLoading && <PageLoading label={t("dashboard.preview.loading")} />}
            {previewQuery.isError && !previewQuery.isLoading && (
              <PageError onRetry={() => void previewQuery.refetch()} />
            )}
            {previewData?.analysis && (
              <div className="mx-4 mt-4 rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">Context / Plot Summary / Glossary</div>
                <pre className="whitespace-pre-wrap text-xs text-gray-200 leading-relaxed">{previewData.analysis}</pre>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <button onClick={() => handleCopy(previewData.analysis || "", t("dashboard.preview.copiedContext"))} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200">{t("dashboard.preview.copyContext")}</button>
                  <button onClick={() => handleCopy(plot || "", t("dashboard.preview.copiedPlot"))} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200">{t("dashboard.preview.copyPlot")}</button>
                  <button onClick={() => handleCopy(glossary || "", t("dashboard.preview.copiedGlossary"))} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200">{t("dashboard.preview.copyGlossary")}</button>
                </div>
              </div>
            )}
            {previewData && filteredLines.length === 0 && !previewQuery.isLoading && (
              <div className="py-10 text-center text-sm text-gray-500">{t("dashboard.preview.noLines")}</div>
            )}
            {previewData && filteredLines.length > 0 && (
              <div ref={listStartRef}>
                {shouldVirtualize ? (
                  isMobile
                    ? <PreviewMobileVirtual lines={filteredLines} virtualizer={virtualizer} editCtx={editCtx} effective={effectiveTranslated} />
                    : <PreviewDesktopVirtual lines={filteredLines} virtualizer={virtualizer} editCtx={editCtx} effective={effectiveTranslated} />
                ) : isMobile ? (
                  <PreviewMobileList lines={filteredLines} editCtx={editCtx} effective={effectiveTranslated} />
                ) : (
                  <PreviewDesktopTable lines={filteredLines} editCtx={editCtx} effective={effectiveTranslated} />
                )}
              </div>
            )}
          </div>
          {previewData && filteredLines.length > 0 && (
            <div className="border-t border-gray-800 px-5 py-3 flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={() => {
                  const tsv = filteredLines.map((l) => `${l.index}\t${l.original}\t${effectiveTranslated(l)}`).join("\n");
                  void handleCopy(tsv, t("dashboard.toast.copiedTSV"));
                }}
                className="rounded-xl border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:text-gray-200"
              >
                {t("dashboard.preview.copyTSV")}
              </button>
              <a
                href={jobDownloadUrl(jobId)}
                download
                className="rounded-xl border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:text-gray-200"
              >
                {t("dashboard.preview.download")}
              </a>
              <button
                onClick={() => void handleSave()}
                disabled={dirtyCount === 0 || isSaving}
                className={`rounded-xl px-3 py-2 text-xs font-medium ${
                  dirtyCount === 0 || isSaving
                    ? "cursor-not-allowed bg-gray-800 text-gray-600"
                    : "bg-blue-600 text-white hover:bg-blue-500"
                }`}
              >
                {isSaving
                  ? t("dashboard.preview.saving")
                  : dirtyCount > 0
                    ? t("dashboard.preview.saveChangesCount", { count: dirtyCount })
                    : t("dashboard.preview.saveChanges")}
              </button>
            </div>
          )}
      </div>
    </ModalShell>
  );
}

function hasIssue(line: PreviewLine, translatedOverride?: string): boolean {
  const original = line.original?.trim() || "";
  const translated = (translatedOverride ?? line.translated ?? "").trim();

  const isUntranslated = original.length > 0 && translated.length === 0;
  const isSuspiciousShort = translated.length > 0 && original.length > 35 && translated.length < original.length * 0.12;
  const isSuspiciousLong = translated.length > 0 && translated.length > original.length * 4;

  return Boolean(isUntranslated || isSuspiciousShort || isSuspiciousLong);
}

function filterLines(
  lines: PreviewLine[],
  search: string,
  effective: (line: PreviewLine) => string
): PreviewLine[] {
  if (!search) return lines;
  const q = search.toLowerCase();
  return lines.filter((l) => l.original.toLowerCase().includes(q) || effective(l).toLowerCase().includes(q));
}

// Auto-growing translated-text editor bound to the shared edit context, keyed
// by the stable cue index. Works identically in the table, list, and windowed
// paths because state lives in the parent, not in row position.
function TranslatedEditor({ line, editCtx }: { line: PreviewLine; editCtx: EditCtx }) {
  const edited = editCtx.getValue(line.index);
  const value = edited !== undefined ? edited : line.translated;
  const dirty = editCtx.isDirty(line.index);
  return (
    <textarea
      value={value}
      onChange={(e) => editCtx.onChange(line.index, e.target.value)}
      placeholder={editCtx.placeholder}
      rows={1}
      aria-label={editCtx.placeholder}
      className={`w-full resize-y rounded border bg-gray-900/60 px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500 ${
        dirty ? "border-blue-600/70 bg-blue-950/30" : "border-transparent hover:border-gray-700"
      }`}
      style={{ minHeight: "1.75rem", fieldSizing: "content" } as React.CSSProperties}
    />
  );
}

function PreviewDesktopTable({
  lines,
  editCtx,
  effective,
}: {
  lines: PreviewLine[];
  editCtx: EditCtx;
  effective: (line: PreviewLine) => string;
}) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-gray-900 text-gray-500 text-[10px] uppercase">
        <tr>
          <th className="px-3 py-2 text-left w-8">{t("dashboard.preview.colIndex")}</th>
          <th className="px-3 py-2 text-left w-24">{t("dashboard.preview.colTime")}</th>
          <th className="px-3 py-2 text-left">{t("dashboard.preview.colOriginal")}</th>
          <th className="px-3 py-2 text-left">{t("dashboard.preview.colTranslated")}</th>
          <th className="px-3 py-2 text-left w-8"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800/30">
        {lines.map((line) => <PreviewLineRow key={line.index} line={line} table editCtx={editCtx} effective={effective} />)}
      </tbody>
    </table>
  );
}

function PreviewMobileList({
  lines,
  editCtx,
  effective,
}: {
  lines: PreviewLine[];
  editCtx: EditCtx;
  effective: (line: PreviewLine) => string;
}) {
  return (
    <div className="space-y-3 p-4">
      {lines.map((line) => <PreviewLineRow key={line.index} line={line} editCtx={editCtx} effective={effective} />)}
    </div>
  );
}

type Virtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;

// Windowed desktop body. Uses a CSS-grid header + absolutely-positioned grid
// rows (mirroring JobsTableDesktop) because <tr>/<table> can't be absolutely
// positioned inside the virtualizer spacer. Column widths come from
// DESKTOP_GRID_COLS so the header and rows stay aligned.
function PreviewDesktopVirtual({
  lines,
  virtualizer,
  editCtx,
  effective,
}: {
  lines: PreviewLine[];
  virtualizer: Virtualizer;
  editCtx: EditCtx;
  effective: (line: PreviewLine) => string;
}) {
  const { t } = useTranslation();
  const TH = "px-3 py-2 text-left";
  return (
    <div className="text-sm">
      <div
        className="sticky top-0 z-10 grid bg-gray-900 text-gray-500 text-[10px] uppercase"
        style={{ gridTemplateColumns: DESKTOP_GRID_COLS }}
      >
        <div className={TH}>{t("dashboard.preview.colIndex")}</div>
        <div className={TH}>{t("dashboard.preview.colTime")}</div>
        <div className={TH}>{t("dashboard.preview.colOriginal")}</div>
        <div className={TH}>{t("dashboard.preview.colTranslated")}</div>
        <div className={TH}></div>
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((vitem) => {
          const line = lines[vitem.index];
          return (
            <PreviewLineGridRow
              key={line.index}
              line={line}
              dataIndex={vitem.index}
              measureRef={virtualizer.measureElement}
              start={vitem.start - virtualizer.options.scrollMargin}
              editCtx={editCtx}
              effective={effective}
            />
          );
        })}
      </div>
    </div>
  );
}

// Windowed mobile body. Same card markup as PreviewMobileList, absolutely
// positioned inside the virtualizer spacer.
function PreviewMobileVirtual({
  lines,
  virtualizer,
  editCtx,
  effective,
}: {
  lines: PreviewLine[];
  virtualizer: Virtualizer;
  editCtx: EditCtx;
  effective: (line: PreviewLine) => string;
}) {
  return (
    <div className="p-4">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((vitem) => {
          const line = lines[vitem.index];
          return (
            <div
              key={line.index}
              data-index={vitem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                paddingBottom: 12,
                transform: `translateY(${vitem.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <PreviewLineRow line={line} editCtx={editCtx} effective={effective} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PreviewLineRow({
  line,
  table = false,
  editCtx,
  effective,
}: {
  line: PreviewLine;
  table?: boolean;
  editCtx: EditCtx;
  effective: (line: PreviewLine) => string;
}) {
  const { t } = useTranslation();
  const issue = hasIssue(line, effective(line));

  if (table) {
    return (
      <tr id={`preview-line-${line.index}`} className={issue ? "bg-yellow-900/5" : ""}>
        <td className="px-3 py-1.5 text-gray-600 text-[10px] align-top">{line.index}</td>
        <td className="px-3 py-1.5 text-[10px] text-gray-600 font-mono align-top whitespace-nowrap">{formatTimecode(line.start)}</td>
        <td className="px-3 py-1.5 text-gray-300 align-top text-xs">{line.original}</td>
        <td className="px-3 py-1.5 align-top text-xs"><TranslatedEditor line={line} editCtx={editCtx} /></td>
        <td className="px-3 py-1.5 align-top">{issue && <span className="text-yellow-500 text-[10px]">⚠</span>}</td>
      </tr>
    );
  }

  return (
    <div id={`preview-line-${line.index}`} className={`rounded-2xl border p-3 ${issue ? "border-yellow-800/50 bg-yellow-900/10" : "border-gray-800 bg-gray-950/40"}`}>
      <div className="mb-2 flex items-center justify-between text-[11px] text-gray-500">
        <span>#{line.index}</span>
        <span className="font-mono">{formatTimecode(line.start)}</span>
      </div>
      <div className="space-y-2 text-xs">
        <div>
          <div className="mb-1 text-[10px] uppercase text-gray-600">{t("dashboard.preview.colOriginal")}</div>
          <div className="text-gray-300">{line.original}</div>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase text-gray-600">{t("dashboard.preview.colTranslated")}</div>
          <TranslatedEditor line={line} editCtx={editCtx} />
        </div>
      </div>
    </div>
  );
}

// Grid-layout equivalent of the desktop table row, used only on the windowed
// path. Same id (for jump-to-issue), same issue highlight, same cell content
// as the <tr> variant, but laid out via DESKTOP_GRID_COLS and absolutely
// positioned inside the virtualizer spacer.
function PreviewLineGridRow({
  line,
  dataIndex,
  measureRef,
  start,
  editCtx,
  effective,
}: {
  line: PreviewLine;
  dataIndex: number;
  measureRef: (el: HTMLElement | null) => void;
  start: number;
  editCtx: EditCtx;
  effective: (line: PreviewLine) => string;
}) {
  const issue = hasIssue(line, effective(line));
  return (
    <div
      id={`preview-line-${line.index}`}
      data-index={dataIndex}
      ref={measureRef}
      className={`grid border-b border-gray-800/30 ${issue ? "bg-yellow-900/5" : ""}`}
      style={{
        gridTemplateColumns: DESKTOP_GRID_COLS,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start}px)`,
      }}
    >
      <div className="px-3 py-1.5 text-gray-600 text-[10px]">{line.index}</div>
      <div className="px-3 py-1.5 text-[10px] text-gray-600 font-mono whitespace-nowrap">{formatTimecode(line.start)}</div>
      <div className="px-3 py-1.5 text-gray-300 text-xs">{line.original}</div>
      <div className="px-3 py-1.5 text-xs"><TranslatedEditor line={line} editCtx={editCtx} /></div>
      <div className="px-3 py-1.5">{issue && <span className="text-yellow-500 text-[10px]">⚠</span>}</div>
    </div>
  );
}
