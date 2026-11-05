/** The home page's views. The Jobs view is the main one; it also lists files with no job yet. */
export const DASHBOARD_VIEWS = ["jobs", "transcriptions"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/**
 * The Jobs view's status filter: job statuses, plus the two kinds of file rows
 * that have no job yet (see file-rows.ts).
 */
export const JOB_STATUS_FILTERS = [
  "all",
  "needsTranscription",
  "notQueued",
  "pending",
  "translating",
  "done",
  "error",
  "skipped",
] as const;
export type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number];

/** How the Jobs view lists its rows: one per job, or one per Library file with its language chips. */
export const ROW_LAYOUTS = ["jobs", "files"] as const;
export type RowLayout = (typeof ROW_LAYOUTS)[number];

/** The home page's state, kept in the URL so a view or status can be linked and survives reload. */
export interface DashboardParams {
  view: DashboardView;
  status: JobStatusFilter;
  rows: RowLayout;
  /** The folder shown, media-relative ("UniFi/Tutorials"), with its subfolders; "all" for the whole library. */
  folder: string;
}

export const DEFAULT_DASHBOARD_PARAMS: Readonly<DashboardParams> = {
  view: "jobs",
  status: "all",
  rows: "jobs",
  folder: "all",
};

// Links from before the Files view was merged into Jobs: `?filter=` named a
// Files status chip. Each maps to the Jobs status that shows the same work.
const LEGACY_FILTER_STATUS: Record<string, JobStatusFilter> = {
  needsTranscription: "needsTranscription",
  missingLanguage: "notQueued",
  error: "error",
  inProgress: "translating",
  done: "done",
};

function oneOf<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function parseDashboardParams(search: URLSearchParams): DashboardParams {
  const legacy = LEGACY_FILTER_STATUS[search.get("filter") ?? ""];
  return {
    view: oneOf(DASHBOARD_VIEWS, search.get("view"), DEFAULT_DASHBOARD_PARAMS.view),
    status: oneOf(JOB_STATUS_FILTERS, search.get("status"), legacy ?? DEFAULT_DASHBOARD_PARAMS.status),
    // view=files is a link from before Files became a row layout of the Jobs view.
    rows: oneOf(ROW_LAYOUTS, search.get("rows") ?? (search.get("view") === "files" ? "files" : null), "jobs"),
    folder: search.get("folder")?.replace(/^\/+|\/+$/g, "") || DEFAULT_DASHBOARD_PARAMS.folder,
  };
}

/** Search params for the given state, defaults omitted so the plain page stays at "/". */
export function dashboardSearchParams(params: Partial<DashboardParams>): URLSearchParams {
  const search = new URLSearchParams();
  for (const key of ["view", "status", "rows", "folder"] as const) {
    const value = params[key];
    if (value !== undefined && value !== DEFAULT_DASHBOARD_PARAMS[key]) search.set(key, value);
  }
  return search;
}

export function dashboardHref(params: Partial<DashboardParams>): string {
  const search = dashboardSearchParams(params).toString();
  return search ? `/?${search}` : "/";
}
