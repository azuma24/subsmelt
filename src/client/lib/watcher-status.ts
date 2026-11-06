import type { WatcherStatus } from "../../shared/watcher";

export function watcherLabelKey(status: WatcherStatus | undefined, unreachable: boolean) {
  if (unreachable || (status?.fileEvents === "unavailable" && !status.running)) return "app.watcherUnavailable";
  if (!status) return "common.loading";
  if (status.running) return "app.watcherActive";
  if (status.fileEvents === "starting") return "app.watcherStarting";
  return "app.watcherInactive";
}
