import { useMemo } from "react";
import type { TFunction } from "i18next";
import type { JobRow } from "../../types";

export function parentFolderLabel(filePath: string, mediaDir: string, rootLabel: string, externalLabel: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedMedia = mediaDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalizedPath.startsWith(`${normalizedMedia}/`)
    ? normalizedPath.slice(normalizedMedia.length + 1)
    : "";

  if (!relative) return externalLabel;
  const parts = relative.split("/");
  parts.pop();
  const folder = parts.join("/");
  return folder || rootLabel;
}

interface StatusSegment {
  key: string;
  label: string;
  count: number;
  color: string;
  activeColor: string;
}

interface FilterTab {
  key: string;
  label: string;
  count: number;
}

interface DashboardDerivedStateInput {
  jobs: JobRow[];
  mediaDir: string;
  statusFilter: string;
  folderFilter: string;
  targetFilter: string;
  selectedIds: Set<number>;
  t: TFunction;
}

export interface DashboardDerivedState {
  pendingJobs: JobRow[];
  activeJobs: JobRow[];
  doneJobs: JobRow[];
  errorJobs: JobRow[];
  jobsById: Map<number, JobRow>;
  selectedPendingCount: number;
  selectedPendingIds: number[];
  folderOptions: string[];
  targetOptions: string[];
  filteredJobs: JobRow[];
  visiblePendingIds: number[];
  visibleErrorIds: number[];
  visibleDoneIds: number[];
  visibleRetranslatableIds: number[];
  hasQueueFilters: boolean;
  filterTabs: FilterTab[];
  statusSegments: StatusSegment[];
}

export function useDashboardDerivedState({
  jobs,
  mediaDir,
  statusFilter,
  folderFilter,
  targetFilter,
  selectedIds,
  t,
}: DashboardDerivedStateInput): DashboardDerivedState {
  const pendingJobs = jobs.filter((j) => j.status === "pending");
  const selectedPendingCount = pendingJobs.filter((j) => selectedIds.has(j.id)).length;
  const activeJobs = jobs.filter((j) => j.status === "translating");
  const doneJobs = jobs.filter((j) => j.status === "done");
  const errorJobs = jobs.filter((j) => j.status === "error");
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const selectedPendingIds = pendingJobs.filter((j) => selectedIds.has(j.id)).map((j) => j.id);
  const folderOptions = useMemo(() => Array.from(new Set(
    jobs.map((job) => parentFolderLabel(job.srt_path, mediaDir, t("dashboard.folderRoot"), t("dashboard.folderExternal")))
  )).sort((a, b) => a.localeCompare(b)), [jobs, mediaDir, t]);
  const targetOptions = useMemo(() => Array.from(new Set(
    jobs.map((job) => `${job.target_lang || job.lang_code} (${job.lang_code})`)
  )).sort((a, b) => a.localeCompare(b)), [jobs]);
  const filteredJobs = jobs.filter((j) => {
    const statusMatches = statusFilter === "all" || j.status === statusFilter;
    const folderMatches = folderFilter === "all" || parentFolderLabel(j.srt_path, mediaDir, t("dashboard.folderRoot"), t("dashboard.folderExternal")) === folderFilter;
    const targetMatches = targetFilter === "all" || `${j.target_lang || j.lang_code} (${j.lang_code})` === targetFilter;
    return statusMatches && folderMatches && targetMatches;
  });
  const visiblePendingIds = filteredJobs.filter((j) => j.status === "pending").map((j) => j.id);
  const visibleErrorIds = filteredJobs.filter((j) => j.status === "error").map((j) => j.id);
  const visibleDoneIds = filteredJobs.filter((j) => j.status === "done").map((j) => j.id);
  const visibleRetranslatableIds = filteredJobs.filter((j) => j.status === "done" || j.status === "skipped").map((j) => j.id);
  const hasQueueFilters = statusFilter !== "all" || folderFilter !== "all" || targetFilter !== "all";

  const filterTabs: FilterTab[] = [
    { key: "all", label: t("dashboard.filter.all"), count: jobs.length },
    { key: "pending", label: t("dashboard.filter.pending"), count: pendingJobs.length },
    { key: "translating", label: t("dashboard.filter.translating"), count: activeJobs.length },
    { key: "done", label: t("dashboard.filter.done"), count: doneJobs.length },
    { key: "error", label: t("dashboard.filter.error"), count: errorJobs.length },
  ];

  // Status strip segments — double as filter tabs (L1)
  const statusSegments: StatusSegment[] = [
    { key: "all", label: t("dashboard.filter.all"), count: jobs.length, color: "text-[var(--text)]", activeColor: "text-[var(--accent)]" },
    { key: "pending", label: t("dashboard.stat.pending"), count: pendingJobs.length, color: "text-[var(--yellow)]", activeColor: "text-[var(--yellow)]" },
    { key: "translating", label: t("dashboard.stat.translating"), count: activeJobs.length, color: "text-[var(--accent)]", activeColor: "text-[var(--accent)]" },
    { key: "done", label: t("dashboard.stat.done"), count: doneJobs.length, color: "text-[var(--green)]", activeColor: "text-[var(--green)]" },
    { key: "error", label: t("dashboard.stat.errors"), count: errorJobs.length, color: "text-[var(--red)]", activeColor: "text-[var(--red)]" },
  ];

  return {
    pendingJobs,
    activeJobs,
    doneJobs,
    errorJobs,
    jobsById,
    selectedPendingCount,
    selectedPendingIds,
    folderOptions,
    targetOptions,
    filteredJobs,
    visiblePendingIds,
    visibleErrorIds,
    visibleDoneIds,
    visibleRetranslatableIds,
    hasQueueFilters,
    filterTabs,
    statusSegments,
  };
}
