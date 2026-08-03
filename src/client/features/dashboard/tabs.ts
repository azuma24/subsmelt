/**
 * The dashboard's top-level tabs.
 *
 * This was declared identically in both DashboardPage and QueueToolbar. The two
 * copies were free to drift, and did: QueueToolbar compared a tab key against
 * "error" — not one of these three values — so its red count styling was
 * unreachable dead code until a typecheck caught it.
 */
export type DashboardTab = "queue" | "transcription" | "scan";

export interface DashboardTabItem {
  key: DashboardTab;
  label: string;
  count: number;
}
