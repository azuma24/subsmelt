export interface WatcherStatus {
  enabled: boolean;
  running: boolean;
  fileEvents: "off" | "starting" | "watching" | "unavailable";
  pollIntervalMinutes: number;
}
