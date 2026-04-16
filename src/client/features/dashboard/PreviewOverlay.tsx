import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useJobPreview } from "../../hooks";
import { formatTimecode } from "../../lib";
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

export function PreviewOverlay({ isMobile, jobId, previewSearch, setPreviewSearch, onClose }: PreviewOverlayProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const previewQuery = useJobPreview(jobId);
  const previewData = previewQuery.data;
  const [showOnlyChanged, setShowOnlyChanged] = useState(false);
  const [showOnlyIssues, setShowOnlyIssues] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const { plot, glossary } = useMemo(() => splitAnalysisSections(previewData?.analysis || ""), [previewData?.analysis]);

  const filteredLines = useMemo(() => {
    let lines = filterLines(previewData?.lines || [], previewSearch);
    if (showOnlyChanged) lines = lines.filter((l) => l.original.trim() !== l.translated.trim());
    if (showOnlyIssues) lines = lines.filter((l) => hasIssue(l));
    return lines;
  }, [previewData?.lines, previewSearch, showOnlyChanged, showOnlyIssues]);

  const jumpToNextIssue = () => {
    const firstIssue = filteredLines.find((line) => hasIssue(line));
    if (!firstIssue) {
      addToast(t("dashboard.preview.noIssues"), "info");
      return;
    }
    const el = document.getElementById(`preview-line-${firstIssue.index}`);
    if (el && listRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-0 md:p-4" onClick={onClose}>
      <div className={`mx-auto flex h-full ${isMobile ? "w-full" : "max-w-6xl items-center justify-center"}`}>
        <div className={`flex w-full flex-col overflow-hidden border border-gray-700 bg-gray-900 ${isMobile ? "h-full rounded-none" : "max-h-[90vh] rounded-3xl"}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-4 border-b border-gray-800 px-5 py-4">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">{previewData?.srtPath?.split("/").pop() || t("dashboard.action.preview")}</h3>
              {previewData?.targetLang && <p className="text-xs text-gray-500">→ {previewData.targetLang} • {filteredLines.length}</p>}
            </div>
            <input
              type="text"
              value={previewSearch}
              onChange={(e) => setPreviewSearch(e.target.value)}
              placeholder={t("dashboard.preview.search")}
              className="w-40 rounded-xl border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 md:w-56"
            />
            <button onClick={onClose} className="text-lg text-gray-400 hover:text-white">×</button>
          </div>
          <div className="border-b border-gray-800 px-4 py-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <button onClick={() => setShowOnlyChanged((v) => !v)} className={`rounded-lg px-2 py-1 ${showOnlyChanged ? "bg-blue-700 text-white" : "bg-gray-800 text-gray-300"}`}>{t("dashboard.preview.showOnlyChanged")}</button>
              <button onClick={() => setShowOnlyIssues((v) => !v)} className={`rounded-lg px-2 py-1 ${showOnlyIssues ? "bg-yellow-700 text-white" : "bg-gray-800 text-gray-300"}`}>{t("dashboard.preview.showOnlyIssues")}</button>
              <button onClick={jumpToNextIssue} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-300">{t("dashboard.preview.nextIssue")}</button>
            </div>
          </div>
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {previewQuery.isLoading && <div className="py-10 text-center text-sm text-gray-500">{t("dashboard.preview.loading")}</div>}
            {previewData?.analysis && (
              <div className="mx-4 mt-4 rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">Context / Plot Summary / Glossary</div>
                <pre className="whitespace-pre-wrap text-xs text-gray-200 leading-relaxed">{previewData.analysis}</pre>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <button onClick={() => { navigator.clipboard.writeText(previewData.analysis || ""); addToast(t("dashboard.preview.copiedContext"), "success"); }} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200">{t("dashboard.preview.copyContext")}</button>
                  <button onClick={() => { navigator.clipboard.writeText(plot || ""); addToast(t("dashboard.preview.copiedPlot"), "success"); }} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200">{t("dashboard.preview.copyPlot")}</button>
                  <button onClick={() => { navigator.clipboard.writeText(glossary || ""); addToast(t("dashboard.preview.copiedGlossary"), "success"); }} className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200">{t("dashboard.preview.copyGlossary")}</button>
                </div>
              </div>
            )}
            {previewData && filteredLines.length === 0 && !previewQuery.isLoading && (
              <div className="py-10 text-center text-sm text-gray-500">{t("dashboard.preview.noLines")}</div>
            )}
            {previewData && filteredLines.length > 0 && (
              isMobile
                ? <PreviewMobileList lines={filteredLines} />
                : <PreviewDesktopTable lines={filteredLines} />
            )}
          </div>
          {previewData && filteredLines.length > 0 && (
            <div className="border-t border-gray-800 px-5 py-3 flex justify-end">
              <button
                onClick={() => {
                  const tsv = filteredLines.map((l) => `${l.index}\t${l.original}\t${l.translated}`).join("\n");
                  navigator.clipboard.writeText(tsv);
                  addToast(t("dashboard.toast.copiedTSV"), "success");
                }}
                className="rounded-xl border border-gray-700 px-3 py-2 text-xs text-gray-400 hover:text-gray-200"
              >
                {t("dashboard.preview.copyTSV")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
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
