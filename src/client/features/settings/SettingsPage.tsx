import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useJobsQuery, useSettingsQuery, useTasksQuery, useTranscriptionHealthQuery } from "../../hooks";
import { SetupProgress, type SetupStep } from "./SetupProgress";
import { useToast } from "../../components/Toast";
import { Accordion, ActionButton, SettingsSection } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { JSON_BLOB_SETTINGS, getStr, validateJsonSetting, type JsonBlobSettingKey } from "./settings-model";
import { str } from "../../lib/settings-value";
import { EngineSection } from "./sections/EngineSection";
import { InterfaceSection } from "./sections/InterfaceSection";
import { LlmSection } from "./sections/LlmSection";
import { SourcesSection } from "./sections/SourcesSection";
import { SttSection } from "./sections/SttSection";

type SectionKey = "llm" | "engine" | "sources" | "stt" | "iface";

export function SettingsPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const settingsQuery = useSettingsQuery();
  const tasksQuery = useTasksQuery();
  const jobsQuery = useJobsQuery();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const transcriptionHealthQuery = useTranscriptionHealthQuery(Boolean(str(settings.transcription_backend_url)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingTranscription, setTestingTranscription] = useState(false);
  const [transcriptionTestResult, setTranscriptionTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingNotification, setTestingNotification] = useState(false);
  const [notificationTestResult, setNotificationTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [activeSection, setActiveSection] = useState<SectionKey>("llm");

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
      .catch((e: unknown) => {
        // Keep the form dirty so the value isn't lost, and surface the failure
        // instead of swallowing it (debounced autosaves otherwise fail silently).
        setDirty(true);
        addToast(t("settings.saveFailed", { message: getErrorMessage(e) }), "error");
      });
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

  // NOTE: The five section trees below are intentionally NOT wrapped in useMemo.
  // Each one closes over the inline update()/updateAndSave()/
  // updateAndSaveDebounced() handlers, which are themselves recreated every
  // render and depend on the debounced-save + save-chain refs and the latest
  // `settings`/`dirty`/`saving`. Correctly memoizing the elements would require
  // either listing all of those (defeating the memo) or hoisting the handlers
  // into useCallback — a larger refactor that risks breaking the carefully-
  // ordered save closures. Per the perf task's guidance, correctness wins here,
  // so these stay as plain values.
  //
  // Which writer each section uses is load-bearing and unchanged by the
  // extraction: LLM and Engine autosave everything (debounced); Sources saves
  // its pickers immediately but leaves the four Advanced fields to the topbar
  // Save; STT is deferred throughout except the backend token.
  const sectionMeta: Record<SectionKey, { navLabel: string; title: string; description: string; content: ReactNode }> = {
    llm: {
      navLabel: t("settings.llmConnection.title"),
      title: t("settings.llmConnection.title"),
      description: t("settings.llmConnection.description"),
      content: <LlmSection settings={settings} isMobile={isMobile} updateAndSaveDebounced={updateAndSaveDebounced} addToast={addToast} />,
    },
    engine: {
      navLabel: t("settings.translationEngine.title"),
      title: t("settings.translationEngine.title"),
      description: t("settings.translationEngine.description"),
      content: <EngineSection settings={settings} isMobile={isMobile} updateAndSaveDebounced={updateAndSaveDebounced} />,
    },
    sources: {
      navLabel: t("settings.sources.title"),
      title: t("settings.sources.title"),
      description: t("settings.sources.description"),
      content: (
        <SourcesSection
          settings={settings}
          isMobile={isMobile}
          update={update}
          updateAndSave={updateAndSave}
          updateManyAndSave={updateManyAndSave}
          updateAndSaveDebounced={updateAndSaveDebounced}
          onToggleWatcher={toggleWatcher}
          onNotificationTest={handleNotificationTest}
          testingNotification={testingNotification}
          notificationTestResult={notificationTestResult}
        />
      ),
    },
    stt: {
      navLabel: t("settings.transcription.title"),
      title: t("settings.transcription.title"),
      description: t("settings.transcription.description"),
      content: (
        <SttSection
          settings={settings}
          isMobile={isMobile}
          update={update}
          updateAndSaveDebounced={updateAndSaveDebounced}
          healthQuery={transcriptionHealthQuery}
          dirty={dirty}
          saving={saving}
          onSave={handleSave}
          onTest={handleTranscriptionTest}
          testing={testingTranscription}
          testResult={transcriptionTestResult}
        />
      ),
    },
    iface: {
      navLabel: t("settings.interface.title"),
      title: t("settings.interface.title"),
      description: t("settings.interface.description"),
      content: <InterfaceSection />,
    },
  };
  const navOrder: SectionKey[] = ["llm", "engine", "sources", "stt", "iface"];

  // First-run signposting. Both queries are already in the app-level cache, so
  // this costs no extra requests. Copy is shared with the Dashboard checklist
  // rather than duplicated — see SetupProgress for why this isn't a wizard.
  const enabledTaskCount = (tasksQuery.data || []).filter((task) => task.enabled === 1).length;
  const hasDiscoveredMedia = (jobsQuery.data?.jobs || []).length > 0;
  const setupSteps: SetupStep[] = [
    {
      key: "llm",
      done: settings._llm_configured === true,
      title: t("dashboard.quickStart.llmTitle"),
      hint: t("dashboard.quickStart.llmHint"),
      actionLabel: t("settings.setup.goToSection"),
      // Already in Settings — jump to the section rather than navigating away.
      onAction: () => setActiveSection("llm"),
    },
    {
      key: "tasks",
      done: enabledTaskCount > 0,
      title: t("dashboard.quickStart.tasksTitle"),
      hint: t("dashboard.quickStart.tasksHint"),
      actionLabel: t("dashboard.quickStart.openTranslations"),
      onAction: () => navigate("/translations"),
    },
    {
      key: "media",
      done: hasDiscoveredMedia,
      title: t("dashboard.quickStart.mediaTitle"),
      hint: t("dashboard.quickStart.mediaHint"),
      actionLabel: t("dashboard.quickStart.scanNow"),
      // Scanning lives on the Dashboard; don't duplicate the action here.
      onAction: () => navigate("/"),
    },
  ];

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
        <SetupProgress steps={setupSteps} />
        {isMobile ? (
          // One disclosure mechanism for all five sections — the shared
          // Accordion, which carries aria-expanded/aria-controls and a caret
          // that actually rotates. LLM stays open on arrival as before.
          <div className="space-y-2.5">
            {navOrder.map((key) => (
              <Accordion key={key} title={sectionMeta[key].title} defaultOpen={key === "llm"}>
                <div className="space-y-4">
                  <p className="text-[11.5px] leading-6 text-[var(--text-2)]">{sectionMeta[key].description}</p>
                  {sectionMeta[key].content}
                </div>
              </Accordion>
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
