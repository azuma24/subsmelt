import { useTranslation } from "react-i18next";
import { Accordion, ActionButton, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { labelCls, selectCls } from "./shared";

interface NotificationsFieldsProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Immediate save — used by the format select, as before the extraction. */
  updateAndSave: (key: string, value: unknown) => void;
  /** Debounced autosave — used by the two free-text fields, as before. */
  updateAndSaveDebounced: (key: string, value: unknown) => void;
  onTest: () => void;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
}

/**
 * Outbound webhook notifications — disabled by default (empty URL).
 *
 * Save mechanics preserved verbatim from the inline version: the webhook URL
 * and the event list autosave on a debounce, the format select saves
 * immediately, and nothing here waits on the topbar Save button.
 */
export function NotificationsFields({ settings, isMobile, updateAndSave, updateAndSaveDebounced, onTest, testing, testResult }: NotificationsFieldsProps) {
  const { t } = useTranslation();
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
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
          <div>
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
          <Field
            label={t("settings.notifications.events")}
            value={str(settings.notify_events, "job:error,queue:finished")}
            onChange={(v) => updateAndSaveDebounced("notify_events", v)}
            placeholder="job:error,queue:finished"
          />
        </div>
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
