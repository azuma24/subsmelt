import { useTranslation } from "react-i18next";
import { Accordion } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { ConnectionsPanel } from "../ConnectionsPanel";
import { labelCls } from "./shared";

type ToastFn = (message: string, type: "success" | "error" | "info") => void;

interface LlmSectionProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Autosaving writer (debounced) — every field in this section autosaves. */
  updateAndSaveDebounced: (key: string, value: unknown) => void;
  addToast: ToastFn;
}

/**
 * LLM Connections. Every control here autosaves through
 * `updateAndSaveDebounced` — nothing in this section waits for the topbar Save.
 */
export function LlmSection({ settings, isMobile, updateAndSaveDebounced, addToast }: LlmSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectionsPanel settings={settings} update={updateAndSaveDebounced} addToast={addToast} isMobile={isMobile} />
      {/* Temperature moved to Advanced accordion per Phase 3 spec */}
      <Accordion title={t("settings.advanced")}>
        <div className="md:max-w-[320px]">
          <label className={labelCls}>{t("settings.llmConnection.temperatureLabel")}: <span className="font-mono text-[var(--accent)]">{str(settings.temperature, "0.3")}</span></label>
          <input type="range" min="0" max="2" step="0.1" aria-label={t("settings.llmConnection.temperatureLabel")} value={str(settings.temperature, "0.3")} onChange={(e) => updateAndSaveDebounced("temperature", e.target.value)} className="w-full accent-[var(--accent)]" />
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">{t("settings.llmConnection.temperatureHelp")}</p>
        </div>
      </Accordion>
    </>
  );
}
