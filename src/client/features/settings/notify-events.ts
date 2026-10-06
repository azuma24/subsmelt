/** The webhook events a user can pick, in the order the Notifications settings list them. */
export const NOTIFY_EVENTS = [
  { event: "job:done", labelKey: "settings.notifications.eventJobDone" },
  { event: "job:error", labelKey: "settings.notifications.eventJobError" },
  { event: "queue:finished", labelKey: "settings.notifications.eventQueueFinished" },
  { event: "queue:stopped", labelKey: "settings.notifications.eventQueueStopped" },
  { event: "youtube:note", labelKey: "settings.notifications.eventYoutubeNote" },
] as const;

export function parseNotifyEvents(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Turns one event on or off in the comma list, keeping every other entry, unknown ones included. */
export function setNotifyEvent(raw: string, event: string, on: boolean): string {
  const events = parseNotifyEvents(raw).filter((e) => e !== event);
  return (on ? [...events, event] : events).join(",");
}
