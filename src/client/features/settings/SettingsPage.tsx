import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useLlmHealthQuery, useSettingsQuery, useTranscriptionHealthQuery } from "../../hooks";
import { DEFAULT_PROMPT, LANGUAGES } from "../../app/constants";
import { useToast } from "../../components/Toast";
import { ActionButton, Field, SettingsSection } from "../../ui/primitives";
import { MediaSourcesPanel } from "./MediaSourcesPanel";
import { TranscriptionReadinessPanel } from "./TranscriptionReadinessPanel";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown): boolean => Boolean(v);

export function SettingsPage({ isMobile }: { isMobile: boolean }) {
  const { t, i18n } = useTranslation();
  const { addToast } = useToast();
  const settingsQuery = useSettingsQuery();
  const llmHealthQuery = useLlmHealthQuery(Boolean(str(settingsQuery.data?.llm_endpoint)));
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const transcriptionHealthQuery = useTranscriptionHealthQuery(Boolean(str(settings.transcription_backend_url)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingTranscription, setTestingTranscription] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [transcriptionTestResult, setTranscriptionTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [apiType, setApiType] = useState<"openai" | "lmstudio">("openai");
  const currentLanguage = LANGUAGES.find((lang) => i18n.language === lang.code || i18n.language.startsWith(`${lang.code}-`))?.code || "en";

  useEffect(() => {
    if (settingsQuery.data) setSettings(settingsQuery.data);
  }, [settingsQuery.data]);

  const update = (key: string, value: unknown) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
  };

  const updateAndSave = async (key: string, value: unknown) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    try {
      await api.saveSettings(next);
      setDirty(false);
    } catch {
      setDirty(true);
    }
  };

  const updateManyAndSave = async (updates: Record<string, unknown>) => {
    const next = { ...settings, ...updates };
    setSettings(next);
    try {
      await api.saveSettings(next);
      setDirty(false);
    } catch {
      setDirty(true);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveSettings(settings);
      setDirty(false);
      addToast(t("settings.saved"), "success");
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      addToast(t("settings.saveFailed", { message }), "error");
    }
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (dirty) {
        await api.saveSettings(settings);
        setDirty(false);
      }
      const result = await api.testConnection();
      setTestResult(result);
      addToast(
        result.ok ? t("settings.testConnectionSuccess") : t("settings.testConnectionFailed", { message: result.message }),
        result.ok ? "success" : "error",
      );
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      setTestResult({ ok: false, message });
      addToast(t("settings.testFailedToast", { message }), "error");
    }
    setTesting(false);
  };

  const handleTranscriptionTest = async () => {
    setTestingTranscription(true);
    setTranscriptionTestResult(null);
    try {
      if (dirty) {
        await api.saveSettings(settings);
        setDirty(false);
      }
      const result = await api.getTranscriptionHealth();
      const message = result.ok
        ? t("settings.transcription.testReachable")
        : result.message || result.reason || t("settings.transcription.testNotReachable");
      setTranscriptionTestResult({ ok: result.ok, message });
      addToast(message, result.ok ? "success" : "error");
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      setTranscriptionTestResult({ ok: false, message });
      addToast(message, "error");
    }
    setTestingTranscription(false);
  };

  const toggleWatcher = async () => {
    try {
      if (settings._watcher_running) {
        await api.stopWatcher();
        setSettings((s) => ({ ...s, _watcher_running: false }));
        addToast(t("settings.watcherStopped"), "info");
      } else {
        await api.startWatcher();
        setSettings((s) => ({ ...s, _watcher_running: true }));
        addToast(t("settings.watcherStarted"), "success");
      }
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      addToast(t("settings.watcherError", { message }), "error");
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-6">
      {isMobile && dirty && <div className="rounded-2xl border border-yellow-800/40 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-200">{t("settings.unsavedBanner")}</div>}
      <section className="rounded-3xl border border-gray-800 bg-gray-900/80 p-5 md:p-6">
        <div className={`flex ${isMobile ? "flex-col gap-4" : "items-center justify-between gap-4"}`}>
          <div><h1 className="text-2xl font-semibold">{t("settings.title")}</h1></div>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-yellow-500">{t("common.unsavedChanges")}</span>}
            <ActionButton onClick={handleSave} disabled={!dirty || saving}>{saving ? t("app.saving") : t("app.save")}</ActionButton>
          </div>
        </div>
      </section>

      <div className="space-y-6">
        <SettingsSection title={t("settings.interface.title")} description={t("settings.interface.description")}>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.interface.language")}</label>
            <select
              value={currentLanguage}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              className="w-full md:max-w-[22rem] rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-gray-600">{t("settings.interface.languageHint")}</p>
          </div>
        </SettingsSection>

        <SettingsSection title={t("settings.llmConnection.title")} description={t("settings.llmConnection.description")}>
          {/* ── Tab switcher: Local vs Cloud ── */}
          <div className="flex gap-1 rounded-2xl bg-gray-950/60 p-1 w-fit">
            {(["local", "openai", "anthropic", "gemini"] as const).map((p) => (
              <button
                key={p}
                onClick={() => update("cloud_provider", p)}
                className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  str(settings.cloud_provider, "local") === p
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {t(`settings.llmConnection.provider_${p}`)}
              </button>
            ))}
          </div>

          {/* ── Local / self-hosted panel ── */}
          {str(settings.cloud_provider, "local") === "local" && (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.llmConnection.apiType")}</label>
                <select value={apiType} onChange={(e) => { const next = e.target.value as "openai" | "lmstudio"; setApiType(next); const base = str(settings.llm_endpoint).replace(/\/(v1|api\/v1)\/?$/, ""); if (base) update("llm_endpoint", base + (next === "lmstudio" ? "/api/v1" : "/v1")); }} className="w-full md:max-w-[22rem] rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                  <option value="openai">{t("settings.llmConnection.apiTypeOpenAI")}</option>
                  <option value="lmstudio">{t("settings.llmConnection.apiTypeLMStudio")}</option>
                </select>
              </div>
              <Field
                label={t("settings.llmConnection.endpoint")}
                value={str(settings.llm_endpoint)}
                onChange={(v) => update("llm_endpoint", v)}
                placeholder={apiType === "lmstudio" ? t("settings.llmConnection.endpointPlaceholderLMStudio") : t("settings.llmConnection.endpointPlaceholderOpenAI")}
              />
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.llmConnection.apiKey")}</label>
                <div className="flex gap-2">
                  <input type={showApiKey ? "text" : "password"} value={str(settings.api_key)} onChange={(e) => update("api_key", e.target.value)} placeholder={t("settings.llmConnection.apiKeyPlaceholder")} className="flex-1 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200" />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="rounded-2xl border border-gray-700 bg-gray-800 px-4 py-3 text-xs text-gray-400">{showApiKey ? "🙈" : "👁"}</button>
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-300">{t("settings.llmConnection.model")}</label>
                  <button
                    onClick={async () => {
                      setLoadingModels(true);
                      try {
                        if (dirty) { await api.saveSettings(settings); setDirty(false); }
                        const res = await fetch("/api/models");
                        const data = await res.json();
                        if (data.models?.length) setModels(data.models);
                        else addToast(data.error || t("settings.llmConnection.noModelsFound"), "error");
                      } catch (e: unknown) {
                        const message = e instanceof Error ? e.message : String(e);
                        addToast(message, "error");
                      }
                      setLoadingModels(false);
                    }}
                    className="text-[10px] text-blue-400"
                  >
                    {loadingModels ? t("common.loading") : t("settings.llmConnection.fetchModels")}
                  </button>
                </div>
                {models.length > 0 ? (
                  <select value={str(settings.model)} onChange={(e) => update("model", e.target.value)} className="w-full md:max-w-[22rem] rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                    <option value="">{t("settings.llmConnection.selectModel")}</option>
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input type="text" value={str(settings.model)} onChange={(e) => update("model", e.target.value)} placeholder={t("settings.llmConnection.modelPlaceholder")} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200" />
                )}
              </div>
              <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-3">
                <div className="mb-2 text-xs font-semibold text-gray-400">{t("settings.llmConnection.healthTitle")}</div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className={`rounded-full px-2 py-1 ${llmHealthQuery.data?.endpointReachable ? "bg-green-900/30 text-green-200" : "bg-red-900/30 text-red-200"}`}>{t("settings.llmConnection.healthEndpoint")}: {llmHealthQuery.data?.endpointReachable ? t("settings.llmConnection.healthOk") : t("settings.llmConnection.healthFail")}</span>
                  <span className={`rounded-full px-2 py-1 ${llmHealthQuery.data?.modelConfigured ? "bg-blue-900/30 text-blue-200" : "bg-gray-800 text-gray-300"}`}>{t("settings.llmConnection.healthModelConfigured")}: {llmHealthQuery.data?.modelConfigured ? t("settings.llmConnection.healthOk") : t("settings.llmConnection.healthMissing")}</span>
                  <span className={`rounded-full px-2 py-1 ${llmHealthQuery.data?.modelAvailable ? "bg-green-900/30 text-green-200" : "bg-yellow-900/30 text-yellow-200"}`}>{t("settings.llmConnection.healthModelAvailable")}: {llmHealthQuery.data?.modelAvailable ? t("settings.llmConnection.healthOk") : t("settings.llmConnection.healthMissing")}</span>
                  {llmHealthQuery.data?.reason && <span className="rounded-full bg-gray-800 px-2 py-1 text-gray-300">{t("settings.llmConnection.healthReason")}: {llmHealthQuery.data.reason}</span>}
                </div>
              </div>
            </>
          )}

          {/* ── Cloud provider panels ── */}
          {(["openai", "anthropic", "gemini"] as const).map((p) => str(settings.cloud_provider, "local") === p && (
            <div key={p} className="space-y-4">
              <div className="rounded-2xl border border-blue-900/40 bg-blue-950/20 px-4 py-3 text-sm text-blue-200">
                {t(`settings.llmConnection.provider_${p}_hint`)}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.llmConnection.cloudApiKey")}</label>
                <div className="flex gap-2">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={str(settings[`cloud_api_key_${p}`])}
                    onChange={(e) => update(`cloud_api_key_${p}`, e.target.value)}
                    placeholder={t(`settings.llmConnection.provider_${p}_key_placeholder`)}
                    className="flex-1 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
                  />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="rounded-2xl border border-gray-700 bg-gray-800 px-4 py-3 text-xs text-gray-400">{showApiKey ? "🙈" : "👁"}</button>
                </div>
                <p className="mt-1 text-[10px] text-gray-500">{t(`settings.llmConnection.provider_${p}_key_hint`)}</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.llmConnection.cloudModel")}</label>
                <input
                  type="text"
                  value={str(settings[`cloud_model_${p}`])}
                  onChange={(e) => update(`cloud_model_${p}`, e.target.value)}
                  placeholder={t(`settings.llmConnection.provider_${p}_model_placeholder`)}
                  className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
                />
                <p className="mt-1 text-[10px] text-gray-500">{t(`settings.llmConnection.provider_${p}_model_hint`)}</p>
              </div>
            </div>
          ))}

          {/* ── Temperature (shared) ── */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.llmConnection.temperatureLabel")}: <span className="font-mono text-blue-400">{str(settings.temperature, "0.7")}</span></label>
            <input type="range" min="0" max="2" step="0.1" value={str(settings.temperature, "0.7")} onChange={(e) => update("temperature", e.target.value)} className="w-full accent-blue-500" />
            <p className="mt-2 text-xs leading-relaxed text-gray-400">{t("settings.llmConnection.temperatureHelp")}</p>
          </div>

          {/* ── Test button (shared) ── */}
          <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
            <ActionButton variant="ghost" onClick={handleTest}>{testing ? t("app.testing") : t("app.testConnection")}</ActionButton>
            {testResult && (
              <span className={`text-sm ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                {testResult.ok
                  ? t("settings.llmConnection.testSuccess", { model: str(settings.model, "model"), endpoint: str(settings.llm_endpoint) })
                  : testResult.message.includes("ECONNREFUSED")
                    ? t("settings.llmConnection.testRefused")
                    : t("settings.llmConnection.testFailed", { message: testResult.message })}
              </span>
            )}
          </div>
        </SettingsSection>
        <SettingsSection title={t("settings.transcription.title")} description={t("settings.transcription.description")}>
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">{t("settings.transcription.enableLabel")}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{t("settings.transcription.enableHelp")}</p>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              checked={str(settings.transcription_enabled, "0") === "1"}
              onChange={(e) => update("transcription_enabled", e.target.checked ? "1" : "0")}
            />
          </label>
          <Field
            label={t("settings.transcription.backendUrl")}
            value={str(settings.transcription_backend_url)}
            onChange={(v) => update("transcription_backend_url", v)}
            placeholder="http://whisper-backend:8001"
            help={t("settings.transcription.backendUrlHelp")}
          />
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <Field
              label={t("settings.transcription.pathMapFrom")}
              value={str(settings.transcription_path_map_from)}
              onChange={(v) => update("transcription_path_map_from", v)}
              placeholder="/media"
              help={t("settings.transcription.pathMapFromHelp")}
            />
            <Field
              label={t("settings.transcription.pathMapTo")}
              value={str(settings.transcription_path_map_to)}
              onChange={(v) => update("transcription_path_map_to", v)}
              placeholder="/mnt/media"
              help={t("settings.transcription.pathMapToHelp")}
            />
          </div>
          <div className="rounded-2xl border border-gray-800 bg-gray-950/50 p-3 text-[11px] leading-relaxed text-gray-400">
            {t("settings.transcription.pathMapExample", { source: "/media/anime/Episode 01.mkv", target: "/srv/media/anime/Episode 01.mkv", from: "/media", to: "/srv/media" })}
          </div>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.model")}</label>
              <select value={str(settings.transcription_model, "small")} onChange={(e) => update("transcription_model", e.target.value)} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                <option value="base">{t("settings.transcription.modelBase")}</option>
                <option value="small">{t("settings.transcription.modelSmall")}</option>
                <option value="medium">{t("settings.transcription.modelMedium")}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.language")}</label>
              <select value={str(settings.transcription_language, "auto")} onChange={(e) => update("transcription_language", e.target.value)} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                <option value="auto">{t("settings.transcription.languageAuto")}</option>
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="zh">Chinese</option>
                <option value="ko">Korean</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.output")}</label>
              <select value={str(settings.transcription_output_format, "srt")} onChange={(e) => update("transcription_output_format", e.target.value)} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                <option value="srt">SRT</option>
                <option value="vtt">VTT</option>
                <option value="txt">TXT</option>
              </select>
            </div>
          </div>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
            <Field label={t("settings.transcription.device")} value={str(settings.transcription_device, "cpu")} onChange={(v) => update("transcription_device", v)} help={t("settings.transcription.deviceHelp")} />
            <Field label={t("settings.transcription.computeType")} value={str(settings.transcription_compute_type, "int8")} onChange={(v) => update("transcription_compute_type", v)} help={t("settings.transcription.computeTypeHelp")} />
            <Field label={t("settings.transcription.maxConcurrent")} value={str(settings.transcription_max_concurrent, "1")} onChange={(v) => update("transcription_max_concurrent", v)} type="number" help={t("settings.transcription.maxConcurrentHelp")} />
          </div>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
            <Field label={t("settings.transcription.maxLineLength")} value={str(settings.transcription_max_line_length, "42")} onChange={(v) => update("transcription_max_line_length", v)} type="number" help={t("settings.transcription.maxLineLengthHelp")} />
            <Field label={t("settings.transcription.maxSubtitleDuration")} value={str(settings.transcription_max_subtitle_duration, "6")} onChange={(v) => update("transcription_max_subtitle_duration", v)} type="number" help={t("settings.transcription.maxSubtitleDurationHelp")} />
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
              <div>
                <p className="text-sm font-medium text-gray-300">{t("settings.transcription.mergeShortSegments")}</p>
                <p className="mt-0.5 text-[10px] text-gray-500">{t("settings.transcription.mergeShortSegmentsHelp")}</p>
              </div>
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
                checked={str(settings.transcription_merge_short_segments, "0") === "1"}
                onChange={(e) => update("transcription_merge_short_segments", e.target.checked ? "1" : "0")}
              />
            </label>
          </div>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.folderDefaults")}</label>
              <textarea
                value={str(settings.transcription_folder_defaults, "[]")}
                onChange={(e) => update("transcription_folder_defaults", e.target.value)}
                rows={7}
                placeholder={'[{"path":"/media/anime","language":"ja","model":"small"}]'}
                className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 font-mono text-xs text-gray-200"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-gray-500">{t("settings.transcription.folderDefaultsHelp")}</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.advancedOptions")}</label>
              <textarea
                value={str(settings.transcription_advanced_stt, "{}")}
                onChange={(e) => update("transcription_advanced_stt", e.target.value)}
                rows={7}
                placeholder={'{"beam_size":5,"word_timestamps":true,"initial_prompt":"Lecture audio"}'}
                className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 font-mono text-xs text-gray-200"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-gray-500">{t("settings.transcription.advancedOptionsHelp")}</p>
            </div>
          </div>
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">{t("settings.transcription.useVad")}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{t("settings.transcription.useVadHelp")}</p>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              checked={str(settings.transcription_use_vad, "1") === "1"}
              onChange={(e) => update("transcription_use_vad", e.target.checked ? "1" : "0")}
            />
          </label>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.missingSubtitleBehavior")}</label>
              <select value={str(settings.transcription_missing_subtitle_behavior, "ask")} onChange={(e) => update("transcription_missing_subtitle_behavior", e.target.value)} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                <option value="ask">{t("settings.transcription.missingAsk")}</option>
                <option value="auto_transcribe">{t("settings.transcription.missingAutoTranscribe")}</option>
                <option value="auto_transcribe_and_translate">{t("settings.transcription.missingAutoTranscribeTranslate")}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.transcription.lowRamBehavior")}</label>
              <select value={str(settings.transcription_low_ram_behavior, "ask")} onChange={(e) => update("transcription_low_ram_behavior", e.target.value)} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200">
                <option value="ask">{t("settings.transcription.lowRamAsk")}</option>
                <option value="downgrade">{t("settings.transcription.lowRamDowngrade")}</option>
                <option value="skip">{t("settings.transcription.lowRamSkip")}</option>
                <option value="run_anyway">{t("settings.transcription.lowRamRunAnyway")}</option>
              </select>
            </div>
          </div>
          <TranscriptionReadinessPanel settings={settings} healthQuery={transcriptionHealthQuery} dirty={dirty} />
          <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
            <ActionButton variant="ghost" onClick={handleTranscriptionTest}>{testingTranscription ? t("app.testing") : t("settings.transcription.testButton")}</ActionButton>
            {transcriptionTestResult && (
              <span className={`text-sm ${transcriptionTestResult.ok ? "text-green-400" : "text-red-400"}`}>{transcriptionTestResult.message}</span>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title={t("settings.translationEngine.title")} description={t("settings.translationEngine.description")}>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-gray-300">{t("settings.translationEngine.systemPrompt")}</label>
              <button onClick={() => update("prompt", DEFAULT_PROMPT)} className="text-[10px] text-gray-600">{t("common.reset")}</button>
            </div>
            <textarea value={str(settings.prompt)} onChange={(e) => update("prompt", e.target.value)} rows={8} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200 font-mono leading-relaxed" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">{t("settings.translationEngine.additionalContext")}</label>
            <textarea value={str(settings.additional_context)} onChange={(e) => update("additional_context", e.target.value)} rows={3} placeholder={t("settings.translationEngine.additionalContextPlaceholder")} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200" />
          </div>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <Field label={t("settings.translationEngine.chunkSize")} value={str(settings.chunk_size, "20")} onChange={(v) => update("chunk_size", v)} help={t("settings.translationEngine.chunkSizeHint")} type="number" />
            <Field label={t("settings.translationEngine.contextWindow")} value={str(settings.context_window, "5")} onChange={(v) => update("context_window", v)} help={t("settings.translationEngine.contextWindowHint")} type="number" />
            <Field label={t("settings.translationEngine.parallelChunks")} value={str(settings.parallel_chunks, "1")} onChange={(v) => update("parallel_chunks", v)} help={t("settings.translationEngine.parallelChunksHint")} type="number" />
            <Field label={t("settings.translationEngine.requestTimeout", "Request Timeout (s)")} value={str(settings.request_timeout_s, "300")} onChange={(v) => update("request_timeout_s", v)} help={t("settings.translationEngine.requestTimeoutHint", "Max seconds to wait for a single LLM response. Increase for slow/large thinking models (e.g. 600).")} type="number" />
            <div className="flex items-center gap-3 py-1">
              <input type="checkbox" id="disable_tool_calls" checked={settings.disable_tool_calls === "1"} onChange={(e) => update("disable_tool_calls", e.target.checked ? "1" : "0")} className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-blue-500" />
              <label htmlFor="disable_tool_calls" className="text-sm text-gray-300">
                {t("settings.translationEngine.disableToolCalls", "Disable tool calls (use plain-text mode)")}
              </label>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title={t("settings.sources.title")} description={t("settings.sources.description")}>
          <MediaSourcesPanel
            isMobile={isMobile}
            mediaDir={str(settings._media_dir, "/media")}
            scanMode={str(settings.scan_mode, "recursive")}
            scanFolders={str(settings.scan_folders)}
            scanExcludeFolders={str(settings.scan_exclude_folders)}
            scanProfiles={str(settings.scan_profiles, "[]")}
            onScanModeChange={(mode) => updateAndSave("scan_mode", mode)}
            onScanFoldersChange={(folders) => updateAndSave("scan_folders", folders)}
            onScanExcludeFoldersChange={(folders) => updateAndSave("scan_exclude_folders", folders)}
            onScanScopeChange={(scope) => updateManyAndSave({
              scan_mode: scope.scanMode,
              scan_folders: scope.scanFolders,
              scan_exclude_folders: scope.scanExcludeFolders,
            })}
            onScanProfilesChange={(profiles) => updateAndSave("scan_profiles", profiles)}
          />
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">{t("settings.sources.autoTranslate")}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{t("settings.sources.autoTranslateHint")}</p>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              checked={str(settings.auto_translate, "1") === "1"}
              onChange={(e) => updateAndSave("auto_translate", e.target.checked ? "1" : "0")}
            />
          </label>
          <div className="flex items-center justify-between rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">{t("settings.sources.fileWatcher")}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{t("settings.sources.fileWatcherDesc")}</p>
            </div>
            <ActionButton variant={bool(settings._watcher_running) ? "success" : "ghost"} onClick={toggleWatcher}>{bool(settings._watcher_running) ? t("app.watcherActiveShort") : t("app.watcherInactiveShort")}</ActionButton>
          </div>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <Field label={t("settings.sources.videoExtensions")} value={str(settings.video_extensions)} onChange={(v) => update("video_extensions", v)} help={t("settings.sources.videoExtensionsHint")} />
            <Field label={t("settings.sources.subtitleExtensions")} value={str(settings.subtitle_extensions)} onChange={(v) => update("subtitle_extensions", v)} help={t("settings.sources.subtitleExtensionsHint")} />
          </div>
          <Field label={t("settings.sources.autoScanInterval")} value={str(settings.auto_scan_interval, "0")} onChange={(v) => update("auto_scan_interval", v)} help={t("settings.sources.autoScanIntervalHint")} />
        </SettingsSection>
      </div>

      <p className="pt-2 text-center text-[11px] text-gray-600">
        {t("settings.about.version", { version: __APP_VERSION__ })}
      </p>
    </div>
  );
}
