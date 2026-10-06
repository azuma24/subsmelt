import { useTranslation } from "react-i18next";
import { Accordion, Field, TextArea } from "../../../ui/primitives";
import { DEFAULT_PROMPT } from "../../../app/constants";
import { str } from "../../../lib/settings-value";
import { ToggleRow, labelCls, textareaCls } from "./shared";
import { useIsMobile } from "../../../hooks";

interface EngineSectionProps {
  settings: Record<string, unknown>;
  /** Autosaving writer (debounced) — every field in this section autosaves. */
  updateAndSaveDebounced: (key: string, value: unknown) => void;
}

/**
 * Translation Engine. Like the LLM section, every field here autosaves through
 * `updateAndSaveDebounced`; none of them depend on the topbar Save button.
 *
 * The "Prompt" accordion is the section's primary content and stays open by
 * default; "Advanced" is collapsed, matching Sources and Speech-to-Text.
 */
export function EngineSection({ settings, updateAndSaveDebounced }: EngineSectionProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  return (
    <>
      {/* Prompt + context behind "Prompt" accordion */}
      <Accordion title={t("settings.promptSection")} defaultOpen>
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-muted">{t("settings.translationEngine.systemPrompt")}</label>
              <button onClick={() => updateAndSaveDebounced("prompt", DEFAULT_PROMPT)} className="text-xs text-faint">
                {t("common.reset")}
              </button>
            </div>
            <TextArea
              ariaLabel={t("settings.translationEngine.systemPrompt")}
              value={str(settings.prompt)}
              onChange={(value) => updateAndSaveDebounced("prompt", value)}
              rows={8}
              mono
            />
          </div>
          <div>
            <label className={labelCls}>{t("settings.translationEngine.additionalContext")}</label>
            <TextArea
              ariaLabel={t("settings.translationEngine.additionalContext")}
              value={str(settings.additional_context)}
              onChange={(value) => updateAndSaveDebounced("additional_context", value)}
              rows={3}
              placeholder={t("settings.translationEngine.additionalContextPlaceholder")}
            />
          </div>
        </div>
      </Accordion>
      {/* Chunk/parallel/timeout + disable tool calls → Advanced accordion */}
      <Accordion title={t("settings.advanced")}>
        <div className="space-y-4">
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <Field
              label={t("settings.translationEngine.chunkSize")}
              value={str(settings.chunk_size, "20")}
              onChange={(v) => updateAndSaveDebounced("chunk_size", v)}
              help={t("settings.translationEngine.chunkSizeHint")}
              type="number"
              min={1}
              max={500}
            />
            <Field
              label={t("settings.translationEngine.contextWindow")}
              value={str(settings.context_window, "5")}
              onChange={(v) => updateAndSaveDebounced("context_window", v)}
              help={t("settings.translationEngine.contextWindowHint")}
              type="number"
              min={0}
              max={100}
            />
            <Field
              label={t("settings.translationEngine.parallelChunks")}
              value={str(settings.parallel_chunks, "1")}
              onChange={(v) => updateAndSaveDebounced("parallel_chunks", v)}
              help={t("settings.translationEngine.parallelChunksHint")}
              type="number"
              min={1}
              max={8}
            />
            <Field
              label={t("settings.translationEngine.requestTimeout")}
              value={str(settings.request_timeout_s, "300")}
              onChange={(v) => updateAndSaveDebounced("request_timeout_s", v)}
              help={t("settings.translationEngine.requestTimeoutHint")}
              type="number"
              min={10}
              max={7200}
            />
          </div>
          <ToggleRow
            title={t("settings.translationEngine.disableToolCalls")}
            checked={settings.disable_tool_calls === "1"}
            onChange={(checked) => updateAndSaveDebounced("disable_tool_calls", checked ? "1" : "0")}
          />
          <ToggleRow
            title={t("settings.translationEngine.refinePass")}
            description={t("settings.translationEngine.refinePassHint")}
            checked={settings.refine_pass === "1"}
            onChange={(checked) => updateAndSaveDebounced("refine_pass", checked ? "1" : "0")}
          />
          <ToggleRow
            title={t("settings.translationEngine.titleSidecar")}
            description={t("settings.translationEngine.titleSidecarHint")}
            checked={settings.title_sidecar === "1"}
            onChange={(checked) => updateAndSaveDebounced("title_sidecar", checked ? "1" : "0")}
          />
        </div>
      </Accordion>
    </>
  );
}
