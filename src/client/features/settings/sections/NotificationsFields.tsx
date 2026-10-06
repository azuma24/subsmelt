import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Accordion, ActionButton, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { NOTIFY_EVENTS, parseNotifyEvents, setNotifyEvent } from "../notify-events";
import { REDACTED_SECRET } from "../settings-model";
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
  // The URL carries the webhook's token, so the server only says one is saved.
  // Emptying a half-typed replacement goes back to the saved one; Remove clears it.
  const webhook = str(settings.notify_webhook_url);
  const webhookSaved = webhook === REDACTED_SECRET;
  const hadSavedWebhook = useRef(false);
  if (webhookSaved) hadSavedWebhook.current = true;
  const removeWebhook = () => {
    hadSavedWebhook.current = false;
    updateAndSaveDebounced("notify_webhook_url", "");
  };
  return (
    <Accordion title={t("settings.notifications.title")}>
      <div className="space-y-4">
        <div className="md:max-w-[420px]">
          <Field
            label={t("settings.notifications.webhookUrl")}
            value={webhookSaved ? "" : webhook}
            onChange={(v) => updateAndSaveDebounced("notify_webhook_url", v === "" && hadSavedWebhook.current ? REDACTED_SECRET : v)}
            placeholder={webhookSaved ? "••••••••" : "https://discord.com/api/webhooks/…"}
            help={webhookSaved ? t("settings.notifications.webhookSaved") : t("settings.notifications.hint")}
          />
          {webhookSaved && (
            <button type="button" onClick={removeWebhook} className="mt-1 min-h-touch text-xs text-danger hover:underline">
              {t("settings.notifications.webhookRemove")}
            </button>
          )}
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
              <label key={event} className="flex min-h-touch cursor-pointer items-center gap-3 text-sm text-text">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-accent"
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
            <span className={`text-sm ${testResult.ok ? "text-success" : "text-danger"}`}><span aria-hidden="true">{testResult.ok ? "✓ " : "✗ "}</span>{testResult.message}</span>
          )}
        </div>
      </div>
    </Accordion>
  );
}
