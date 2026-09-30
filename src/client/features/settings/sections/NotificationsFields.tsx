import { useTranslation } from "react-i18next";
import { Accordion, ActionButton, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { NOTIFY_EVENTS, parseNotifyEvents, setNotifyEvent } from "../notify-events";
import { labelCls, selectCls } from "./shared";

interface NotificationsFieldsProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Immediate save, used by the format select and the event choices. */
  updateAndSave: (key: string, value: unknown) => void;
  /** Debounced autosave, used by the webhook URL. */
  updateAndSaveDebounced: (key: string, value: unknown) => void;
  onTest: () => void;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
}

/**
 * Outbound webhook notifications — disabled by default (empty URL).
 *
 * The webhook URL autosaves on a debounce; the format select and the event
 * choices save immediately. Nothing here waits on the topbar Save button.
 */
export function NotificationsFields({ settings, isMobile, updateAndSave, updateAndSaveDebounced, onTest, testing, testResult }: NotificationsFieldsProps) {
  const { t } = useTranslation();
  const events = str(settings.notify_events, "job:error,queue:finished");
  const chosen = new Set(parseNotifyEvents(events));
  return (
    <Accordion title={t("settings.notifications.title")}>
      <div className="space-y-4">
        <div className="md:max-w-[420px]">
          <Field
            label={t("settings.notifications.webhookUrl")}
            value={str(settings.notify_webhook_url)}
            onChange={(v) => updateAndSaveDebounced("notify_webhook_url", v)}
            placeholder="https://discord.com/api/webhooks/…"
            help={t("settings.notifications.hint")}
          />
        </div>
        <div className="md:max-w-[240px]">
          <label className={labelCls}>{t("settings.notifications.format")}</label>
          <select
            aria-label={t("settings.notifications.format")}
            value={str(settings.notify_format, "json")}
            onChange={(e) => updateAndSave("notify_format", e.target.value)}
            className={selectCls}
          >
            <option value="json">JSON</option>
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
          </select>
        </div>
        <fieldset>
          <legend className={labelCls}>{t("settings.notifications.events")}</legend>
          <div className={`grid gap-x-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            {NOTIFY_EVENTS.map(({ event, labelKey }) => (
              <label key={event} className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[13px] text-[var(--text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                  checked={chosen.has(event)}
                  onChange={(e) => updateAndSave("notify_events", setNotifyEvent(events, event, e.target.checked))}
                />
                <span>{t(labelKey)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
          <ActionButton variant="ghost" size="sm" onClick={onTest} disabled={testing}>
            {testing ? t("app.testing") : t("settings.notifications.sendTest")}
          </ActionButton>
          {testResult && (
            <span className={`text-[13px] ${testResult.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}><span aria-hidden="true">{testResult.ok ? "✓ " : "✗ "}</span>{testResult.message}</span>
          )}
        </div>
      </div>
    </Accordion>
  );
}
