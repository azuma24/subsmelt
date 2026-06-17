import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useSettingsQuery, useTranscriptionHealthQuery } from "../../hooks";
import { DEFAULT_PROMPT, LANGUAGES } from "../../app/constants";
import { getThemePref, setThemePref, THEME_PREFS, type ThemePref } from "../../lib/theme";
import { getFontScale, setFontScale, DEFAULT_SCALE, MIN_SCALE, MAX_SCALE, SCALE_STEP } from "../../lib/font-scale";
import { useToast } from "../../components/Toast";
import { Accordion, ActionButton, Drawer, Field, SettingsSection } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { MediaSourcesPanel } from "./MediaSourcesPanel";
import { TranscriptionReadinessPanel } from "./TranscriptionReadinessPanel";
import { ModelManagerPanel } from "./ModelManagerPanel";
import { JSON_BLOB_SETTINGS, getStr, validateJsonSetting, type JsonBlobSettingKey } from "./settings-model";

// Thin wrappers over the typed accessors so existing call sites (str/bool) stay
// terse. `settings` is still a Record<string, unknown> on the wire.
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown): boolean => Boolean(v);

const selectCls = "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]";
const textareaCls = "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelCls = "mb-1.5 block text-[12px] font-medium text-[var(--text-2)]";

type SectionKey = "llm" | "engine" | "sources" | "stt" | "iface";

export function SettingsPage({ isMobile }: { isMobile: boolean }) {
  const { t, i18n } = useTranslation();
  const { addToast } = useToast();
  const settingsQuery = useSettingsQuery();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const transcriptionHealthQuery = useTranscriptionHealthQuery(Boolean(str(settings.transcription_backend_url)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingTranscription, setTestingTranscription] = useState(false);
  const [transcriptionTestResult, setTranscriptionTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingNotification, setTestingNotification] = useState(false);
  const [notificationTestResult, setNotificationTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [activeSection, setActiveSection] = useState<SectionKey>("llm");
  const [rawConfigDrawerOpen, setRawConfigDrawerOpen] = useState(false);
  const [themePref, setThemePrefState] = useState<ThemePref>(getThemePref());
  const [fontScale, setFontScaleState] = useState<number>(getFontScale());
  const currentLanguage = LANGUAGES.find((lang) => i18n.language === lang.code || i18n.language.startsWith(`${lang.code}-`))?.code || "en";

  // Synchronous mirror of `settings` so rapid update()/updateAndSave() calls in the
  // same tick build on each other instead of overwriting from a stale render closure.
  const settingsRef = useRef<Record<string, unknown>>({});
  // Serializes save POSTs so the last-issued (most complete) body is also the last write.
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Debounce timer for autosaved free-text fields (LLM / Engine), so typing
  // coalesces into one POST instead of one per keystroke.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setSettings(settingsQuery.data);
      settingsRef.current = settingsQuery.data;
    }
  }, [settingsQuery.data]);

  const applyNext = (next: Record<string, unknown>) => {
    settingsRef.current = next;
    setSettings(next);
  };

  // Silent predicate: are both JSON-blob settings well-formed in `s`?
  const jsonBlobsValid = (s: Record<string, unknown>): boolean =>
    (Object.keys(JSON_BLOB_SETTINGS) as JsonBlobSettingKey[]).every(
      (key) => validateJsonSetting(key, getStr(s, key)).ok
    );

  const persist = (next: Record<string, unknown>) => {
    // Guard EVERY save path (debounced edits, unmount flush, transcription
    // test) — never persist a malformed JSON blob that could later break
    // transcription request building. Keep the form dirty so the value isn't
    // lost; handleSave surfaces the toast on an explicit save.
    if (!jsonBlobsValid(next)) {
      setDirty(true);
      return Promise.resolve();
    }
    saveChainRef.current = saveChainRef.current
      .then(() => api.saveSettings(next))
      .then(() => setDirty(false))
      .catch(() => setDirty(true));
    return saveChainRef.current;
  };

  const update = (key: string, value: unknown) => {
    applyNext({ ...settingsRef.current, [key]: value });
    setDirty(true);
  };

  const updateAndSave = async (key: string, value: unknown) => {
    const next = { ...settingsRef.current, [key]: value };
    applyNext(next);
    await persist(next);
  };

  const updateManyAndSave = async (updates: Record<string, unknown>) => {
    const next = { ...settingsRef.current, ...updates };
    applyNext(next);
    await persist(next);
  };

  // Autosave with debounce — for LLM/Engine fields incl. free-text inputs.
  const updateAndSaveDebounced = (key: string, value: unknown, delay = 500) => {
    applyNext({ ...settingsRef.current, [key]: value });
    setDirty(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persist(settingsRef.current);
    }, delay);
  };

  // Flush any pending debounced save on unmount so changes aren't lost on navigate.
  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      persist(settingsRef.current);
    }
  }, []);

  // Validate the two JSON-blob settings (folder defaults + advanced STT) before
  // any save. On failure we toast and DO NOT persist the malformed value.
  // Returns true when all blobs are valid, false when a save should be blocked.
  const validateJsonBlobs = (): boolean => {
    for (const key of Object.keys(JSON_BLOB_SETTINGS) as JsonBlobSettingKey[]) {
      const result = validateJsonSetting(key, getStr(settingsRef.current, key));
      if (!result.ok) {
        const label = t(`settings.transcription.${key === "transcription_folder_defaults" ? "folderDefaults" : "advancedOptions"}`);
        addToast(t("settings.invalidJson", { field: label }), "error");
        return false;
      }
    }
    return true;
  };

  const handleSave = async (): Promise<boolean> => {
    if (!validateJsonBlobs()) return false;
    setSaving(true);
    try {
      await api.saveSettings(settingsRef.current);
      setDirty(false);
      addToast(t("settings.saved"), "success");
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      addToast(t("settings.saveFailed", { message }), "error");
    }
    setSaving(false);
    return true;
  };

  const handleTranscriptionTest = async () => {
    setTestingTranscription(true);
    setTranscriptionTestResult(null);
    try {
      if (dirty) {
        if (!validateJsonBlobs()) { setTestingTranscription(false); return; }
        await api.saveSettings(settingsRef.current);
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

  const handleNotificationTest = async () => {
    setTestingNotification(true);
    setNotificationTestResult(null);
    try {
      // Flush any pending edits so the test uses the latest webhook URL/format.
      if (dirty) {
        if (!validateJsonBlobs()) { setTestingNotification(false); return; }
        await api.saveSettings(settingsRef.current);
        setDirty(false);
      }
      const result = await api.testNotification();
      if (result.ok) {
        setNotificationTestResult({ ok: true, message: t("settings.notifications.testSent") });
        addToast(t("settings.notifications.testSent"), "success");
      } else {
        const message = t("settings.notifications.testFailed", { message: result.error || "unknown" });
        setNotificationTestResult({ ok: false, message });
        addToast(message, "error");
      }
    } catch (e: unknown) {
      const message = t("settings.notifications.testFailed", { message: getErrorMessage(e) });
      setNotificationTestResult({ ok: false, message });
      addToast(message, "error");
    }
    setTestingNotification(false);
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

  // ── LLM Connections ──
  const llmContent = (
    <>
      <ConnectionsPanel settings={settings} update={updateAndSaveDebounced} addToast={addToast} isMobile={isMobile} />
      {/* Temperature moved to Advanced accordion per Phase 3 spec */}
      <Accordion title={t("settings.advanced")}>
        <div className="md:max-w-[320px]">
          <label className={labelCls}>{t("settings.llmConnection.temperatureLabel")}: <span className="font-mono text-[var(--accent)]">{str(settings.temperature, "0.7")}</span></label>
          <input type="range" min="0" max="2" step="0.1" aria-label={t("settings.llmConnection.temperatureLabel")} value={str(settings.temperature, "0.7")} onChange={(e) => updateAndSaveDebounced("temperature", e.target.value)} className="w-full accent-[var(--accent)]" />
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">{t("settings.llmConnection.temperatureHelp")}</p>
        </div>
      </Accordion>
    </>
  );

  // ── Translation Engine ──
  const engineContent = (
    <>
      {/* Prompt + context behind "Prompt" accordion */}
      <Accordion title={t("settings.promptSection")} defaultOpen>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[12px] font-medium text-[var(--text-2)]">{t("settings.translationEngine.systemPrompt")}</label>
              <button onClick={() => updateAndSaveDebounced("prompt", DEFAULT_PROMPT)} className="text-[11px] text-[var(--text-3)]">{t("common.reset")}</button>
            </div>
            <textarea aria-label={t("settings.translationEngine.systemPrompt")} value={str(settings.prompt)} onChange={(e) => updateAndSaveDebounced("prompt", e.target.value)} rows={8} className={`${textareaCls} font-mono leading-relaxed`} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.translationEngine.additionalContext")}</label>
            <textarea aria-label={t("settings.translationEngine.additionalContext")} value={str(settings.additional_context)} onChange={(e) => updateAndSaveDebounced("additional_context", e.target.value)} rows={3} placeholder={t("settings.translationEngine.additionalContextPlaceholder")} className={textareaCls} />
          </div>
        </div>
      </Accordion>
      {/* Chunk/parallel/timeout + disable tool calls → Advanced accordion */}
      <Accordion title={t("settings.advanced")} defaultOpen>
        <div className="space-y-4">
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <Field label={t("settings.translationEngine.chunkSize")} value={str(settings.chunk_size, "20")} onChange={(v) => updateAndSaveDebounced("chunk_size", v)} help={t("settings.translationEngine.chunkSizeHint")} type="number" />
            <Field label={t("settings.translationEngine.contextWindow")} value={str(settings.context_window, "5")} onChange={(v) => updateAndSaveDebounced("context_window", v)} help={t("settings.translationEngine.contextWindowHint")} type="number" />
            <Field label={t("settings.translationEngine.parallelChunks")} value={str(settings.parallel_chunks, "1")} onChange={(v) => updateAndSaveDebounced("parallel_chunks", v)} help={t("settings.translationEngine.parallelChunksHint")} type="number" />
            <Field label={t("settings.translationEngine.requestTimeout", "Request Timeout (s)")} value={str(settings.request_timeout_s, "300")} onChange={(v) => updateAndSaveDebounced("request_timeout_s", v)} help={t("settings.translationEngine.requestTimeoutHint", "Max seconds to wait for a single LLM response.")} type="number" />
          </div>
          <ToggleRow
            title={t("settings.translationEngine.disableToolCalls", "Disable tool calls (use plain-text mode)")}
            checked={settings.disable_tool_calls === "1"}
            onChange={(checked) => updateAndSaveDebounced("disable_tool_calls", checked ? "1" : "0")}
          />
          <ToggleRow
            title={t("settings.translationEngine.refinePass", "Refinement Pass (Pass 2)")}
            description={t("settings.translationEngine.refinePassHint", "Runs a second LLM editing pass to make translations read more naturally — better quality, but ~2× the token cost and slower. Falls back to the first-pass translation if the edit fails. Default off.")}
            checked={settings.refine_pass === "1"}
            onChange={(checked) => updateAndSaveDebounced("refine_pass", checked ? "1" : "0")}
          />
        </div>
      </Accordion>
    </>
  );

  // ── Sources & Monitoring ──
  const sourcesContent = (
    <>
      <MediaSourcesPanel
        isMobile={isMobile}
        mediaDir={str(settings._media_dir, "/media")}
        scanMode={str(settings.scan_mode, "recursive")}
        scanFolders={str(settings.scan_folders)}
        scanExcludeFolders={str(settings.scan_exclude_folders)}
        scanProfiles={str(settings.scan_profiles, "[]")}
        directoryRules={str(settings.directory_rules, "[]")}
        onScanModeChange={(mode) => updateAndSave("scan_mode", mode)}
        onScanFoldersChange={(folders) => updateAndSave("scan_folders", folders)}
        onScanExcludeFoldersChange={(folders) => updateAndSave("scan_exclude_folders", folders)}
        onScanScopeChange={(scope) => updateManyAndSave({
          scan_mode: scope.scanMode,
          scan_folders: scope.scanFolders,
          scan_exclude_folders: scope.scanExcludeFolders,
        })}
        onScanProfilesChange={(profiles) => updateAndSave("scan_profiles", profiles)}
        onDirectoryRulesChange={(rules) => updateAndSave("directory_rules", rules)}
      />
      <ToggleRow
        title={t("settings.sources.autoTranslate")}
        description={t("settings.sources.autoTranslateHint")}
        checked={str(settings.auto_translate, "1") === "1"}
        onChange={(checked) => updateAndSave("auto_translate", checked ? "1" : "0")}
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-[var(--text)]">{t("settings.sources.fileWatcher")}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{t("settings.sources.fileWatcherDesc")}</p>
        </div>
        <ActionButton variant={bool(settings._watcher_running) ? "success" : "ghost"} size="sm" onClick={toggleWatcher}>{bool(settings._watcher_running) ? t("app.watcherActiveShort") : t("app.watcherInactiveShort")}</ActionButton>
      </div>
      {/* Video/subtitle extensions + auto-scan interval → Advanced accordion */}
      <Accordion title={t("settings.advanced")}>
        <div className="space-y-4">
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <Field label={t("settings.sources.videoExtensions")} value={str(settings.video_extensions)} onChange={(v) => update("video_extensions", v)} help={t("settings.sources.videoExtensionsHint")} />
            <Field label={t("settings.sources.subtitleExtensions")} value={str(settings.subtitle_extensions)} onChange={(v) => update("subtitle_extensions", v)} help={t("settings.sources.subtitleExtensionsHint")} />
          </div>
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[420px]`}>
            <Field label={t("settings.sources.autoScanInterval")} value={str(settings.auto_scan_interval, "0")} onChange={(v) => update("auto_scan_interval", v)} help={t("settings.sources.autoScanIntervalHint")} type="number" />
            <Field label={t("settings.sources.monthlyTokenBudget")} value={str(settings.monthly_token_budget, "0")} onChange={(v) => update("monthly_token_budget", v)} help={t("settings.sources.monthlyTokenBudgetHint")} type="number" />
          </div>
        </div>
      </Accordion>
      {/* Outbound webhook notifications — disabled by default (empty URL). */}
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
            <ActionButton variant="ghost" size="sm" onClick={handleNotificationTest} disabled={testingNotification}>
              {testingNotification ? t("app.testing") : t("settings.notifications.sendTest")}
            </ActionButton>
            {notificationTestResult && (
              <span className={`text-[13px] ${notificationTestResult.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{notificationTestResult.message}</span>
            )}
          </div>
        </div>
      </Accordion>
    </>
  );

  // ── Speech-to-Text ──
  // Model options are driven by the backend's advertised capabilities.models so
  // the dropdown always matches what the server (and the model manager) support.
  // Falls back to the full known set before health loads, and always includes the
  // currently-selected model so a saved value (e.g. large-v3) can't be dropped.
  const STT_MODEL_FALLBACK = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"];
  const STT_MODEL_LABEL_KEYS: Record<string, string> = {
    tiny: "settings.transcription.modelTiny",
    base: "settings.transcription.modelBase",
    small: "settings.transcription.modelSmall",
    medium: "settings.transcription.modelMedium",
    "large-v3": "settings.transcription.modelLargeV3",
    "large-v3-turbo": "settings.transcription.modelLargeV3Turbo",
  };
  const advertisedModels = transcriptionHealthQuery.data?.health?.capabilities?.models;
  const selectedSttModel = str(settings.transcription_model, "small");
  const sttModelOptions = (() => {
    const base = advertisedModels && advertisedModels.length ? [...advertisedModels] : [...STT_MODEL_FALLBACK];
    if (!base.includes(selectedSttModel)) base.unshift(selectedSttModel);
    return base;
  })();
  const sttContent = (
    <>
      <ToggleRow
        title={t("settings.transcription.enableLabel")}
        description={t("settings.transcription.enableHelp")}
        checked={str(settings.transcription_enabled, "0") === "1"}
        onChange={(checked) => update("transcription_enabled", checked ? "1" : "0")}
      />
      <div className="md:max-w-[340px]">
        <Field
          label={t("settings.transcription.backendUrl")}
          value={str(settings.transcription_backend_url)}
          onChange={(v) => update("transcription_backend_url", v)}
          placeholder="http://whisper-backend:8001"
          help={t("settings.transcription.backendUrlHelp")}
        />
      </div>
      <div className="md:max-w-[340px]">
        <Field
          label={t("settings.transcription.backendToken")}
          value={str(settings.transcription_backend_token)}
          onChange={(v) => updateAndSaveDebounced("transcription_backend_token", v)}
          type="password"
          placeholder="••••••••"
          help={t("settings.transcription.backendTokenHelp")}
        />
      </div>
      <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
        <ActionButton variant="ghost" size="sm" onClick={handleTranscriptionTest}>{testingTranscription ? t("app.testing") : t("settings.transcription.testButton")}</ActionButton>
        {transcriptionTestResult && (
          <span className={`text-[13px] ${transcriptionTestResult.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{transcriptionTestResult.message}</span>
        )}
      </div>
      <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
        <div>
          <label className={labelCls}>{t("settings.transcription.model")}</label>
          <select aria-label={t("settings.transcription.model")} value={selectedSttModel} onChange={(e) => update("transcription_model", e.target.value)} className={selectCls}>
            {sttModelOptions.map((m) => (
              <option key={m} value={m}>{STT_MODEL_LABEL_KEYS[m] ? t(STT_MODEL_LABEL_KEYS[m]) : m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t("settings.transcription.language")}</label>
          <select aria-label={t("settings.transcription.language")} value={str(settings.transcription_language, "auto")} onChange={(e) => update("transcription_language", e.target.value)} className={selectCls}>
            <option value="auto">{t("settings.transcription.languageAuto")}</option>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
            <option value="ko">Korean</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>{t("settings.transcription.output")}</label>
          <select aria-label={t("settings.transcription.output")} value={str(settings.transcription_output_format, "srt")} onChange={(e) => update("transcription_output_format", e.target.value)} className={selectCls}>
            <option value="srt">SRT</option>
            <option value="vtt">VTT</option>
            <option value="txt">TXT</option>
          </select>
        </div>
      </div>
      <TranscriptionReadinessPanel settings={settings} healthQuery={transcriptionHealthQuery} dirty={dirty} />

      {/* Whisper model manager — proxied to the configured backend. Requires a
          backend URL to be set; download progress streams over SSE. */}
      <ModelManagerPanel enabled={Boolean(str(settings.transcription_backend_url))} />

      {/* Path mapping → accordion */}
      <Accordion title={t("settings.pathMapping")}>
        <div className="space-y-3">
          <div className="md:max-w-[480px]">
            <label className={labelCls}>{t("settings.transcription.transport")}</label>
            <select aria-label={t("settings.transcription.transport")} value={str(settings.transcription_transport, "auto")} onChange={(e) => update("transcription_transport", e.target.value)} className={selectCls}>
              <option value="auto">{t("settings.transcription.transportAuto")}</option>
              <option value="shared">{t("settings.transcription.transportShared")}</option>
              <option value="upload">{t("settings.transcription.transportUpload")}</option>
            </select>
            <p className="mt-1 text-[11px] text-[var(--text-2)]">{t("settings.transcription.transportHelp")}</p>
          </div>
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <Field label={t("settings.transcription.pathMapFrom")} value={str(settings.transcription_path_map_from)} onChange={(v) => update("transcription_path_map_from", v)} placeholder="/media" help={t("settings.transcription.pathMapFromHelp")} />
            <Field label={t("settings.transcription.pathMapTo")} value={str(settings.transcription_path_map_to)} onChange={(v) => update("transcription_path_map_to", v)} placeholder="/mnt/media" help={t("settings.transcription.pathMapToHelp")} />
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[11px] text-[var(--text-2)]">
            {t("settings.transcription.pathMapExample", { source: "/media/anime/Episode 01.mkv", target: "/srv/media/anime/Episode 01.mkv", from: "/media", to: "/srv/media" })}
          </div>
        </div>
      </Accordion>

      {/* Device/compute/concurrent, line length, vad, behaviors → Advanced */}
      <Accordion title={t("settings.advanced")}>
        <div className="space-y-4">
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
            <Field label={t("settings.transcription.device")} value={str(settings.transcription_device, "cpu")} onChange={(v) => update("transcription_device", v)} help={t("settings.transcription.deviceHelp")} />
            <Field label={t("settings.transcription.computeType")} value={str(settings.transcription_compute_type, "int8")} onChange={(v) => update("transcription_compute_type", v)} help={t("settings.transcription.computeTypeHelp")} />
            <Field label={t("settings.transcription.maxConcurrent")} value={str(settings.transcription_max_concurrent, "1")} onChange={(v) => update("transcription_max_concurrent", v)} type="number" help={t("settings.transcription.maxConcurrentHelp")} />
          </div>
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
            <Field label={t("settings.transcription.maxLineLength")} value={str(settings.transcription_max_line_length, "42")} onChange={(v) => update("transcription_max_line_length", v)} type="number" help={t("settings.transcription.maxLineLengthHelp")} />
            <Field label={t("settings.transcription.maxSubtitleDuration")} value={str(settings.transcription_max_subtitle_duration, "6")} onChange={(v) => update("transcription_max_subtitle_duration", v)} type="number" help={t("settings.transcription.maxSubtitleDurationHelp")} />
            <div className="flex items-end">
              <ToggleRow
                title={t("settings.transcription.mergeShortSegments")}
                description={t("settings.transcription.mergeShortSegmentsHelp")}
                checked={str(settings.transcription_merge_short_segments, "0") === "1"}
                onChange={(checked) => update("transcription_merge_short_segments", checked ? "1" : "0")}
              />
            </div>
          </div>
          <ToggleRow
            title={t("settings.transcription.useVad")}
            description={t("settings.transcription.useVadHelp")}
            checked={str(settings.transcription_use_vad, "1") === "1"}
            onChange={(checked) => update("transcription_use_vad", checked ? "1" : "0")}
          />
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <div>
              <label className={labelCls}>{t("settings.transcription.missingSubtitleBehavior")}</label>
              <select aria-label={t("settings.transcription.missingSubtitleBehavior")} value={str(settings.transcription_missing_subtitle_behavior, "ask")} onChange={(e) => update("transcription_missing_subtitle_behavior", e.target.value)} className={selectCls}>
                <option value="ask">{t("settings.transcription.missingAsk")}</option>
                <option value="auto_transcribe">{t("settings.transcription.missingAutoTranscribe")}</option>
                <option value="auto_transcribe_and_translate">{t("settings.transcription.missingAutoTranscribeTranslate")}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t("settings.transcription.lowRamBehavior")}</label>
              <select aria-label={t("settings.transcription.lowRamBehavior")} value={str(settings.transcription_low_ram_behavior, "ask")} onChange={(e) => update("transcription_low_ram_behavior", e.target.value)} className={selectCls}>
                <option value="ask">{t("settings.transcription.lowRamAsk")}</option>
                <option value="downgrade">{t("settings.transcription.lowRamDowngrade")}</option>
                <option value="skip">{t("settings.transcription.lowRamSkip")}</option>
                <option value="run_anyway">{t("settings.transcription.lowRamRunAnyway")}</option>
              </select>
            </div>
          </div>
        </div>
      </Accordion>

      {/* Raw config drawer trigger (L4) — folder defaults + advanced STT */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-[var(--text)]">{t("settings.rawConfig")}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{t("settings.rawConfigHint")}</p>
        </div>
        <ActionButton variant="ghost" size="sm" onClick={() => setRawConfigDrawerOpen(true)}>
          {t("settings.rawConfigOpen")}
        </ActionButton>
      </div>

      {/* Raw Config Drawer — houses the two STT JSON blobs */}
      <Drawer
        open={rawConfigDrawerOpen}
        onClose={() => setRawConfigDrawerOpen(false)}
        title={t("settings.rawConfig")}
      >
        <div className="space-y-5">
          <div>
            <label className={labelCls}>{t("settings.transcription.folderDefaults")}</label>
            <textarea
              aria-label={t("settings.transcription.folderDefaults")}
              value={str(settings.transcription_folder_defaults, "[]")}
              onChange={(e) => update("transcription_folder_defaults", e.target.value)}
              rows={8}
              placeholder={'[{"path":"/media/anime","language":"ja","model":"small"}]'}
              className={`${textareaCls} font-mono text-xs`}
            />
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-3)]">{t("settings.transcription.folderDefaultsHelp")}</p>
          </div>
          <div>
            <label className={labelCls}>{t("settings.transcription.advancedOptions")}</label>
            <textarea
              aria-label={t("settings.transcription.advancedOptions")}
              value={str(settings.transcription_advanced_stt, "{}")}
              onChange={(e) => update("transcription_advanced_stt", e.target.value)}
              rows={8}
              placeholder={'{"beam_size":5,"word_timestamps":true,"initial_prompt":"Lecture audio"}'}
              className={`${textareaCls} font-mono text-xs`}
            />
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-3)]">{t("settings.transcription.advancedOptionsHelp")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <ActionButton variant="ghost" size="sm" onClick={() => setRawConfigDrawerOpen(false)}>{t("common.close")}</ActionButton>
            <ActionButton size="sm" onClick={async () => { if (await handleSave()) setRawConfigDrawerOpen(false); }} disabled={!dirty || saving}>{saving ? t("app.saving") : t("app.save")}</ActionButton>
          </div>
        </div>
      </Drawer>
    </>
  );

  // ── Interface ──
  const ifaceContent = (
    <div className="space-y-4">
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.theme")}</label>
        <select
          aria-label={t("settings.interface.theme")}
          value={themePref}
          onChange={(e) => {
            const next = e.target.value as ThemePref;
            setThemePrefState(next);
            setThemePref(next);
          }}
          className={selectCls}
        >
          {THEME_PREFS.map((pref) => (
            <option key={pref} value={pref}>{t(`settings.interface.theme_${pref}`)}</option>
          ))}
        </select>
        <p className="mt-1 text-[11.5px] text-[var(--text-3)]">{t("settings.interface.themeHint")}</p>
      </div>
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.fontSize", "Font size")}</label>
        <div className="flex items-center gap-2">
          <ActionButton
            variant="ghost"
            size="sm"
            disabled={fontScale <= MIN_SCALE}
            onClick={() => setFontScaleState(setFontScale(fontScale - SCALE_STEP))}
          >
            A−
          </ActionButton>
          <span className="min-w-[3.25rem] text-center font-mono text-[12px] text-[var(--text-2)]">{fontScale}%</span>
          <ActionButton
            variant="ghost"
            size="sm"
            disabled={fontScale >= MAX_SCALE}
            onClick={() => setFontScaleState(setFontScale(fontScale + SCALE_STEP))}
          >
            A+
          </ActionButton>
          <ActionButton
            variant="ghost"
            size="sm"
            disabled={fontScale === DEFAULT_SCALE}
            onClick={() => setFontScaleState(setFontScale(DEFAULT_SCALE))}
          >
            {t("settings.interface.fontSizeReset", "Reset")}
          </ActionButton>
        </div>
        <p className="mt-1 text-[11.5px] text-[var(--text-3)]">{t("settings.interface.fontSizeHint", "Scale the entire interface. Saved on this device.")}</p>
      </div>
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.language")}</label>
        <select
          aria-label={t("settings.interface.language")}
          value={currentLanguage}
          onChange={(e) => i18n.changeLanguage(e.target.value)}
          className={selectCls}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>{lang.label}</option>
          ))}
        </select>
        <p className="mt-1 text-[11.5px] text-[var(--text-3)]">{t("settings.interface.languageHint")}</p>
      </div>
    </div>
  );

  const sectionMeta: Record<SectionKey, { navLabel: string; title: string; description: string; content: ReactNode }> = {
    llm: { navLabel: t("settings.llmConnection.title"), title: t("settings.llmConnection.title"), description: t("settings.llmConnection.description"), content: llmContent },
    engine: { navLabel: t("settings.translationEngine.title"), title: t("settings.translationEngine.title"), description: t("settings.translationEngine.description"), content: engineContent },
    sources: { navLabel: t("settings.sources.title"), title: t("settings.sources.title"), description: t("settings.sources.description"), content: sourcesContent },
    stt: { navLabel: t("settings.transcription.title"), title: t("settings.transcription.title"), description: t("settings.transcription.description"), content: sttContent },
    iface: { navLabel: t("settings.interface.title"), title: t("settings.interface.title"), description: t("settings.interface.description"), content: ifaceContent },
  };
  const navOrder: SectionKey[] = ["llm", "engine", "sources", "stt", "iface"];

  return (
    <div className="flex min-h-full flex-col">
      {/* Topbar */}
      <div className="sticky top-0 z-30 flex h-[50px] shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 md:px-[18px]">
        <span className="flex-1 text-sm font-semibold text-[var(--text)]">{t("settings.title")}</span>
        {dirty && <span className="text-[11px] text-[var(--yellow)]">{t("common.unsavedChanges")}</span>}
        <ActionButton size="sm" onClick={handleSave} disabled={!dirty || saving}>{saving ? t("app.saving") : t("app.save")}</ActionButton>
      </div>

      <div className="flex-1 p-3.5 md:p-[18px]">
        {settingsQuery.isError && (
          <div className="mb-3.5">
            <InlineError onRetry={() => void settingsQuery.refetch()} />
          </div>
        )}
        {isMobile ? (
          <div className="space-y-2.5">
            {/* LLM always expanded */}
            <SettingsSection title={sectionMeta.llm.title} description={sectionMeta.llm.description}>{sectionMeta.llm.content}</SettingsSection>
            {(["engine", "sources", "stt", "iface"] as SectionKey[]).map((key) => (
              <details key={key} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-[18px]">
                <summary className="flex cursor-pointer list-none items-center justify-between text-[13.5px] font-semibold text-[var(--text)]">
                  {sectionMeta[key].title}
                  <span className="text-[12px] text-[var(--text-3)]">▸</span>
                </summary>
                <div className="mt-3.5 space-y-4">{sectionMeta[key].content}</div>
              </details>
            ))}
          </div>
        ) : (
          <div className="grid max-w-[920px] gap-[18px] md:grid-cols-[185px_1fr]">
            <nav className="flex flex-col gap-px">
              {navOrder.map((key) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  className={`rounded-lg border px-[9px] py-1.5 text-left text-[13px] transition-colors ${activeSection === key ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`}
                >
                  {sectionMeta[key].navLabel}
                </button>
              ))}
            </nav>
            <div>
              <SettingsSection title={sectionMeta[activeSection].title} description={sectionMeta[activeSection].description}>
                {sectionMeta[activeSection].content}
              </SettingsSection>
            </div>
          </div>
        )}

        <p className="pt-4 text-center text-[11px] text-[var(--text-3)]">
          {t("settings.about.version", { version: __APP_VERSION__ })}
        </p>
      </div>
    </div>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <div>
        <p className="text-[13px] font-medium text-[var(--text)]">{title}</p>
        {description && <p className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{description}</p>}
      </div>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
