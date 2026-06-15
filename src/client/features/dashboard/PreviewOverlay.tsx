import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useJobPreview } from "../../hooks";
import { formatTimecode } from "../../lib";
import { copyText } from "../../lib/clipboard";
import { ModalShell } from "../../components/ModalShell";
import { PageError, PageLoading } from "../../ui/QueryState";
import { useToast } from "../../components/Toast";
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
const DESKTOP_ROW_ESTIMATE = 32;
const MOBILE_ROW_ESTIMATE = 132;
// Shared grid template for the virtualized desktop rows so the windowed body
// stays column-aligned with the sticky header: # | TIME | ORIGINAL | TRANSLATED | ⚠
const DESKTOP_GRID_COLS = "32px 96px minmax(0,1fr) minmax(0,1fr) 32px";

export function PreviewOverlay({ isMobile, jobId, previewSearch, setPreviewSearch, onClose }: PreviewOverlayProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const previewQuery = useJobPreview(jobId);
  const previewData = previewQuery.data;
  const [showOnlyChanged, setShowOnlyChanged] = useState(false);
  const [showOnlyIssues, setShowOnlyIssues] = useState(false);
  // Outer scroll viewport. Holds the analysis block + the (possibly windowed)
  // cue list, so existing scroll behavior (analysis scrolls with the list) is
  // preserved. When the list is windowed it is also the virtualizer's scroller.
  const listRef = useRef<HTMLDivElement>(null);
  // Marks where the cue list begins inside the scroll viewport so the
  // virtualizer can offset for the analysis block rendered above it.
  const listStartRef = useRef<HTMLDivElement>(null);

  const { plot, glossary } = useMemo(() => splitAnalysisSections(previewData?.analysis || ""), [previewData?.analysis]);

  const filteredLines = useMemo(() => {
    let lines = filterLines(previewData?.lines || [], previewSearch);
    if (showOnlyChanged) lines = lines.filter((l) => l.original.trim() !== l.translated.trim());
    if (showOnlyIssues) lines = lines.filter((l) => hasIssue(l));
    return lines;
  }, [previewData?.lines, previewSearch, showOnlyChanged, showOnlyIssues]);

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
    const issueIdx = filteredLines.findIndex((line) => hasIssue(line));
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
                    ? <PreviewMobileVirtual lines={filteredLines} virtualizer={virtualizer} />
                    : <PreviewDesktopVirtual lines={filteredLines} virtualizer={virtualizer} />
                ) : isMobile ? (
                  <PreviewMobileList lines={filteredLines} />
                ) : (
                  <PreviewDesktopTable lines={filteredLines} />
                )}
              </div>
            )}
          </div>
          {previewData && filteredLines.length > 0 && (
            <div className="border-t border-gray-800 px-5 py-3 flex justify-end">
              <button
                onClick={() => {
                  const tsv = filteredLines.map((l) => `${l.index}\t${l.original}\t${l.translated}`).join("\n");
                  void handleCopy(tsv, t("dashboard.toast.copiedTSV"));
                }}
                className="rounded-xl border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:text-gray-200"
              >
                {t("dashboard.preview.copyTSV")}
              </button>
            </div>
          )}
      </div>
    </ModalShell>
  );
}

function hasIssue(line: PreviewLine): boolean {
  const original = line.original?.trim() || "";
  const translated = line.translated?.trim() || "";

  const isUntranslated = original.length > 0 && translated.length === 0;
  const isSuspiciousShort = translated.length > 0 && original.length > 35 && translated.length < original.length * 0.12;
  const isSuspiciousLong = translated.length > 0 && translated.length > original.length * 4;

  return Boolean(isUntranslated || isSuspiciousShort || isSuspiciousLong);
}

function filterLines(lines: PreviewLine[], search: string): PreviewLine[] {
  if (!search) return lines;
  const q = search.toLowerCase();
  return lines.filter((l) => l.original.toLowerCase().includes(q) || l.translated.toLowerCase().includes(q));
}

function PreviewDesktopTable({ lines }: { lines: PreviewLine[] }) {
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
        {lines.map((line) => <PreviewLineRow key={line.index} line={line} table />)}
      </tbody>
    </table>
  );
}

function PreviewMobileList({ lines }: { lines: PreviewLine[] }) {
  return (
    <div className="space-y-3 p-4">
      {lines.map((line) => <PreviewLineRow key={line.index} line={line} />)}
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
}: {
  lines: PreviewLine[];
  virtualizer: Virtualizer;
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
}: {
  lines: PreviewLine[];
  virtualizer: Virtualizer;
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
              <PreviewLineRow line={line} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PreviewLineRow({ line, table = false }: { line: PreviewLine; table?: boolean }) {
  const { t } = useTranslation();
  const issue = hasIssue(line);

  if (table) {
    return (
      <tr id={`preview-line-${line.index}`} className={issue ? "bg-yellow-900/5" : ""}>
        <td className="px-3 py-1.5 text-gray-600 text-[10px] align-top">{line.index}</td>
        <td className="px-3 py-1.5 text-[10px] text-gray-600 font-mono align-top whitespace-nowrap">{formatTimecode(line.start)}</td>
        <td className="px-3 py-1.5 text-gray-300 align-top text-xs">{line.original}</td>
        <td className="px-3 py-1.5 text-gray-200 align-top text-xs">{line.translated || <span className="text-red-400/60 italic">{t("dashboard.preview.untranslated")}</span>}</td>
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
          <div className="text-gray-100">{line.translated || <span className="text-red-400/60 italic">{t("dashboard.preview.untranslated")}</span>}</div>
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
}: {
  line: PreviewLine;
  dataIndex: number;
  measureRef: (el: HTMLElement | null) => void;
  start: number;
}) {
  const { t } = useTranslation();
  const issue = hasIssue(line);
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
      <div className="px-3 py-1.5 text-gray-200 text-xs">{line.translated || <span className="text-red-400/60 italic">{t("dashboard.preview.untranslated")}</span>}</div>
      <div className="px-3 py-1.5">{issue && <span className="text-yellow-500 text-[10px]">⚠</span>}</div>
    </div>
  );
}
