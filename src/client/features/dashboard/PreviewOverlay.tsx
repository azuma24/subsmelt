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

export function PreviewOverlay({ isMobile, jobId, previewSearch, setPreviewSearch, onClose }: PreviewOverlayProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const previewQuery = useJobPreview(jobId);
  const previewData = previewQuery.data;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-0 md:p-4" onClick={onClose}>
      <div className={`mx-auto flex h-full ${isMobile ? "w-full" : "max-w-6xl items-center justify-center"}`}>
        <div className={`flex w-full flex-col overflow-hidden border border-gray-700 bg-gray-900 ${isMobile ? "h-full rounded-none" : "max-h-[90vh] rounded-3xl"}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-4 border-b border-gray-800 px-5 py-4">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">{previewData?.srtPath?.split("/").pop() || t("dashboard.action.preview")}</h3>
              {previewData?.targetLang && <p className="text-xs text-gray-500">→ {previewData.targetLang} • {previewData.lines.length}</p>}
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
          <div className="flex-1 overflow-y-auto">
            {previewQuery.isLoading && <div className="py-10 text-center text-sm text-gray-500">{t("dashboard.preview.loading")}</div>}
            {previewData && previewData.lines.length === 0 && !previewQuery.isLoading && (
              <div className="py-10 text-center text-sm text-gray-500">{t("dashboard.preview.noLines")}</div>
            )}
            {previewData && previewData.lines.length > 0 && (
              isMobile
                ? <PreviewMobileList lines={previewData.lines} previewSearch={previewSearch} />
                : <PreviewDesktopTable lines={previewData.lines} previewSearch={previewSearch} />
            )}
          </div>
          {previewData && previewData.lines.length > 0 && (
            <div className="border-t border-gray-800 px-5 py-3 flex justify-end">
              <button
                onClick={() => {
                  const tsv = previewData.lines.map((l) => `${l.index}\t${l.original}\t${l.translated}`).join("\n");
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

function filterLines(lines: PreviewLine[], search: string): PreviewLine[] {
  if (!search) return lines;
  const q = search.toLowerCase();
  return lines.filter((l) => l.original.toLowerCase().includes(q) || l.translated.toLowerCase().includes(q));
}

function PreviewDesktopTable({ lines, previewSearch }: { lines: PreviewLine[]; previewSearch: string }) {
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
        {filterLines(lines, previewSearch).map((line) => <PreviewLineRow key={line.index} line={line} table />)}
      </tbody>
    </table>
  );
}

function PreviewMobileList({ lines, previewSearch }: { lines: PreviewLine[]; previewSearch: string }) {
  return (
    <div className="space-y-3 p-4">
      {filterLines(lines, previewSearch).map((line) => <PreviewLineRow key={line.index} line={line} />)}
    </div>
  );
}

function PreviewLineRow({ line, table = false }: { line: PreviewLine; table?: boolean }) {
  const { t } = useTranslation();
  const isUntranslated = line.original && !line.translated;
  const isSuspiciousShort = line.translated && line.original.length > 20 && line.translated.length < line.original.length * 0.2;
  const isSuspiciousLong = line.translated && line.translated.length > line.original.length * 3;
  const hasIssue = isUntranslated || isSuspiciousShort || isSuspiciousLong;

  if (table) {
    return (
      <tr className={hasIssue ? "bg-yellow-900/5" : ""}>
        <td className="px-3 py-1.5 text-gray-600 text-[10px] align-top">{line.index}</td>
        <td className="px-3 py-1.5 text-[10px] text-gray-600 font-mono align-top whitespace-nowrap">{formatTimecode(line.start)}</td>
        <td className="px-3 py-1.5 text-gray-300 align-top text-xs">{line.original}</td>
        <td className="px-3 py-1.5 text-gray-200 align-top text-xs">{line.translated || <span className="text-red-400/60 italic">{t("dashboard.preview.untranslated")}</span>}</td>
        <td className="px-3 py-1.5 align-top">{hasIssue && <span className="text-yellow-500 text-[10px]">⚠</span>}</td>
      </tr>
    );
  }

  return (
    <div className={`rounded-2xl border p-3 ${hasIssue ? "border-yellow-800/50 bg-yellow-900/10" : "border-gray-800 bg-gray-950/40"}`}>
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
