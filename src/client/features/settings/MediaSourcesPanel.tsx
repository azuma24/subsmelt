import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type ScanMode = "recursive" | "root_only" | "selected";

interface MediaSourcesPanelProps {
  isMobile: boolean;
  mediaDir: string;
  scanMode: string;
  scanFolders: string;
  onScanModeChange: (mode: string) => void;
  onScanFoldersChange: (folders: string) => void;
}

const SCAN_MODES: ScanMode[] = ["recursive", "root_only", "selected"];

const parseFolders = (raw: string): string[] =>
  raw.split(",").map((f) => f.trim()).filter(Boolean);

export function MediaSourcesPanel({
  isMobile,
  mediaDir,
  scanMode,
  scanFolders,
  onScanModeChange,
  onScanFoldersChange,
}: MediaSourcesPanelProps) {
  const { t } = useTranslation();
  const [subfolders, setSubfolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSources = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/subfolders");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      const list = (data as { subfolders?: unknown }).subfolders;
      setSubfolders(Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubfolders([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSources();
  }, []);

  const mode: ScanMode = (SCAN_MODES as string[]).includes(scanMode) ? (scanMode as ScanMode) : "recursive";
  const selected = parseFolders(scanFolders);
  const selectedSet = new Set(selected);

  const toggleFolder = (folder: string) => {
    const next = selectedSet.has(folder)
      ? selected.filter((f) => f !== folder)
      : [...selected, folder];
    onScanFoldersChange(next.join(","));
  };

  const summary = (() => {
    if (subfolders.length === 0) return t("settings.sources.summaryNoneDetected", { path: mediaDir });
    if (mode === "recursive") return t("settings.sources.summaryRecursive", { count: subfolders.length });
    if (mode === "root_only") return t("settings.sources.summaryRootOnly", { path: mediaDir });
    if (selected.length === 0) return t("settings.sources.summaryNoneSelected");
    return t("settings.sources.summarySelected", { selected: selected.length, total: subfolders.length });
  })();

  const scanModeOptions = [
    { value: "recursive", label: t("settings.sources.scanRecursive"), desc: t("settings.sources.scanRecursiveDesc") },
    { value: "root_only", label: t("settings.sources.scanRootOnly"), desc: t("settings.sources.scanRootOnlyDesc") },
    { value: "selected", label: t("settings.sources.scanSelected"), desc: t("settings.sources.scanSelectedDesc") },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-400">{t("settings.sources.mediaSourcesIntro")}</p>

      <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-200">{t("settings.sources.detectedSources")}</div>
            <div className="text-[11px] text-gray-500">
              {loading
                ? t("settings.sources.loadingSources")
                : t("settings.sources.detectedCount", { count: subfolders.length })}
              <span className="ml-2 font-mono text-gray-600">{mediaDir}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={fetchSources}
            disabled={loading}
            className="shrink-0 text-[11px] text-blue-400 hover:text-blue-300 disabled:text-gray-600"
          >
            {loading ? t("common.loading") : t("settings.sources.refreshFolders")}
          </button>
        </div>

        {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}

        {!loading && subfolders.length === 0 ? (
          <p className="text-[11px] text-gray-500">{t("settings.sources.summaryNoneDetected", { path: mediaDir })}</p>
        ) : (
          <div className={`grid gap-2 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            {subfolders.map((folder) => {
              const isSelected = selectedSet.has(folder);
              const included = mode === "recursive" || (mode === "selected" && isSelected);
              const isInteractive = mode === "selected";
              return (
                <div
                  key={folder}
                  onClick={isInteractive ? () => toggleFolder(folder) : undefined}
                  className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                    included ? "border-blue-900/60 bg-blue-950/20" : "border-gray-800 bg-gray-900/40"
                  } ${isInteractive ? "cursor-pointer hover:border-blue-800/60" : ""}`}
                >
                  {isInteractive && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleFolder(folder)}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-0.5 accent-blue-500"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-gray-200">{folder}</div>
                    <div className="truncate font-mono text-[10px] text-gray-500">
                      {t("settings.sources.mountedAt", { path: `${mediaDir}/${folder}` })}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium ${
                      included ? "bg-blue-900/40 text-blue-300" : "bg-gray-800 text-gray-500"
                    }`}
                  >
                    {included ? t("settings.sources.includedBadge") : t("settings.sources.excludedBadge")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-300">{t("settings.sources.scanMode")}</label>
        <div className="space-y-2">
          {scanModeOptions.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-3 rounded-2xl border border-gray-800 bg-gray-950/40 p-3"
            >
              <input
                type="radio"
                name="scan_mode"
                value={opt.value}
                checked={mode === opt.value}
                onChange={(e) => onScanModeChange(e.target.value)}
                className="mt-1 accent-blue-500"
              />
              <div>
                <div className="text-sm text-gray-200">{opt.label}</div>
                <p className="text-[10px] text-gray-500">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-3">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">{t("settings.sources.scanSummary")}</div>
        <div className="mt-1 text-sm text-gray-200">{summary}</div>
      </div>

      <details className="rounded-2xl border border-gray-800 bg-gray-950/40 p-3">
        <summary className="cursor-pointer text-[11px] text-gray-400 hover:text-gray-300">
          {t("settings.sources.helpTitle")}
        </summary>
        <p className="mt-2 whitespace-pre-line text-[11px] leading-relaxed text-gray-500">
          {t("settings.sources.helpBody", { path: mediaDir })}
        </p>
      </details>
    </div>
  );
}
