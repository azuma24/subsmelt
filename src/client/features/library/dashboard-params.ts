import { LIBRARY_STATUSES, type LibraryFilter } from "./library-model";

export const DASHBOARD_VIEWS = ["files", "jobs", "transcriptions"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/** The job statuses the Jobs view filters by; keys match useDashboardDerivedState's segments. */
export const JOB_STATUS_FILTERS = ["all", "pending", "translating", "done", "error", "skipped"] as const;
export type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number];

/** The home page's state, kept in the URL so a view, filter or status can be linked and survives reload. */
export interface DashboardParams {
  view: DashboardView;
  /** Files view status chip. */
  filter: LibraryFilter;
  /** Jobs view status segment. */
  status: JobStatusFilter;
}

export const DEFAULT_DASHBOARD_PARAMS: Readonly<DashboardParams> = { view: "files", filter: "all", status: "all" };

const LIBRARY_FILTERS: readonly LibraryFilter[] = ["all", ...LIBRARY_STATUSES];

function oneOf<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function parseDashboardParams(search: URLSearchParams): DashboardParams {
  return {
    view: oneOf(DASHBOARD_VIEWS, search.get("view"), DEFAULT_DASHBOARD_PARAMS.view),
    filter: oneOf(LIBRARY_FILTERS, search.get("filter"), DEFAULT_DASHBOARD_PARAMS.filter),
    status: oneOf(JOB_STATUS_FILTERS, search.get("status"), DEFAULT_DASHBOARD_PARAMS.status),
  };
}

/** Search params for the given state, defaults omitted so the plain page stays at "/". */
export function dashboardSearchParams(params: Partial<DashboardParams>): URLSearchParams {
  const search = new URLSearchParams();
  for (const key of ["view", "filter", "status"] as const) {
    const value = params[key];
    if (value !== undefined && value !== DEFAULT_DASHBOARD_PARAMS[key]) search.set(key, value);
  }
  return search;
}

export function dashboardHref(params: Partial<DashboardParams>): string {
  const search = dashboardSearchParams(params).toString();
  return search ? `/?${search}` : "/";
}
