import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { ScannedFile } from "../../types";
import { STATUS_ICON } from "../../app/constants";

export type ScanFilter = "all" | "new" | "missing" | "orphans";

interface ScanResultsPanelProps {
  files: ScannedFile[];
  filter: ScanFilter;
  setFilter: (v: ScanFilter) => void;
  search: string;
  setSearch: (v: string) => void;
  expandedGroups: Set<string>;
  setExpandedGroups: Dispatch<SetStateAction<Set<string>>>;
}

export function getScanGroupName(file: ScannedFile): string {
  const path = file.videoPath || file.subtitles[0]?.srtPath || "";
  const marker = "/media/";
  const idx = path.indexOf(marker);
  if (idx >= 0) {
    const rest = path.slice(idx + marker.length);
    return rest.split("/")[0] || "root";
  }
  return file.videoName ? "library" : "orphans";
}

export function ScanResultsPanel({ files, filter, setFilter, search, setSearch, expandedGroups, setExpandedGroups }: ScanResultsPanelProps) {
  const { t } = useTranslation();

  const filteredFiles = useMemo(() => {
    const query = search.toLowerCase();
    return files.filter((file) => {
      const matchesSearch = !query || `${file.videoName || ""} ${file.subtitles.map((s) => s.srtName).join(" ")}`.toLowerCase().includes(query);
      if (!matchesSearch) return false;
      if (filter === "orphans") return !file.videoName;
      if (filter === "missing") return !!file.videoName && file.subtitles.length === 0;
      if (filter === "new") return file.subtitles.some((sub) => sub.tasks.some((task) => task.status === "new" || task.status === "pending"));
      return true;
    });
  }, [files, filter, search]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ScannedFile[]>();
    filteredFiles.forEach((file) => {
      const group = getScanGroupName(file);
      grouped.set(group, [...(grouped.get(group) || []), file]);
    });
    return Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredFiles]);
  const toggleGroup = (group: string) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900/80 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-gray-800 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <span className="text-sm font-medium text-gray-300">{t("dashboard.library")}</span>
          <p className="text-xs text-gray-500">{t("app.scanGroupedHint")}</p>
        </div>
        <span className="text-xs text-gray-500">{t("dashboard.entries", { count: filteredFiles.length })}</span>
      </div>
      <div className="border-b border-gray-800 px-4 py-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          {([
            { key: "all", label: t("app.scanFilterAll") },
            { key: "new", label: t("app.scanFilterNew") },
            { key: "missing", label: t("app.scanFilterMissing") },
            { key: "orphans", label: t("app.scanFilterOrphans") },
          ] as const).map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${filter === chip.key ? "bg-blue-600/15 text-white border border-blue-500/30" : "bg-gray-800 text-gray-400"}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("app.scanSearchPlaceholder")}
          className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
        />
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {groups.length === 0 && <div className="px-4 py-6 text-center text-gray-500 text-sm">{t("app.scanNoMatch")}</div>}
        <div className="divide-y divide-gray-800/50">
          {groups.map(([group, groupFiles]) => {
            const expanded = expandedGroups.has(group);
            return (
              <div key={group}>
                <button onClick={() => toggleGroup(group)} className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-800/30">
                  <div>
                    <div className="text-sm font-medium text-gray-200">{group}</div>
                    <div className="text-[11px] text-gray-500">{t("app.scanItems", { count: groupFiles.length })}</div>
                  </div>
                  <div className="text-xs text-gray-500">{expanded ? t("app.scanHide") : t("app.scanShow")}</div>
                </button>
                {expanded && (
                  <div className="border-t border-gray-800/60 bg-gray-950/30">
                    {groupFiles.map((file, i) => <CompactScanFileRow key={`${group}-${i}`} file={file} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function CompactScanFileRow({ file }: { file: ScannedFile }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasNew = file.subtitles.some((sub) => sub.tasks.some((task) => task.status === "new" || task.status === "pending"));
  const missing = file.videoName && file.subtitles.length === 0;
  const orphan = !file.videoName;

  return (
    <div className="border-b border-gray-800/50 last:border-b-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-800/20">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-gray-200">
            <span className="text-gray-500">{file.videoName ? "🎬" : "📝"}</span>
            <span className="truncate font-medium">{file.videoName || t("dashboard.orphanSubtitle")}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-gray-500">
            {hasNew && <span className="rounded-full bg-blue-900/20 px-2 py-0.5 text-blue-300">{t("app.scanNewJobs")}</span>}
            {missing && <span className="rounded-full bg-yellow-900/20 px-2 py-0.5 text-yellow-300">{t("app.scanMissingSubtitles")}</span>}
            {orphan && <span className="rounded-full bg-gray-800 px-2 py-0.5 text-gray-300">{t("app.scanOrphan")}</span>}
            <span>{t("app.subtitleCount", { count: file.subtitles.length })}</span>
          </div>
        </div>
        <div className="text-xs text-gray-500">{open ? t("app.scanHide") : t("app.scanDetails")}</div>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {file.subtitles.length === 0 && file.videoName && <div className="text-xs text-yellow-600">{t("dashboard.noSubtitleFound")}</div>}
          {file.subtitles.map((sub, j) => (
            <div key={j} className="mt-2 rounded-2xl bg-gray-900/60 p-3">
              <div className="text-xs text-gray-300">{sub.srtName}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {sub.tasks.map((task, k) => (
                  <span
                    key={k}
                    className={`rounded-full px-2 py-1 text-[10px] font-medium ${task.status === "done" ? "bg-green-900/30 text-green-500" : task.status === "error" ? "bg-red-900/30 text-red-400" : task.status === "translating" ? "bg-blue-900/30 text-blue-400" : task.status === "pending" ? "bg-yellow-900/20 text-yellow-500" : "bg-gray-800 text-gray-500"}`}
                  >
                    {task.langCode} {STATUS_ICON[task.status]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
