import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
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
import { EMPTY_FORM, edit, editMany, isDirty, receiveServer, saved, view, type SettingsForm } from "./settings-form";
import { EngineSection } from "./sections/EngineSection";
import { InterfaceSection } from "./sections/InterfaceSection";
import { LlmSection } from "./sections/LlmSection";
import { SourcesSection } from "./sections/SourcesSection";
import { SttSection } from "./sections/SttSection";
import { YoutubeSection } from "./sections/YoutubeSection";

const SECTION_KEYS = ["llm", "engine", "sources", "stt", "youtube", "iface"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];
const isSectionKey = (value: string | null): value is SectionKey => SECTION_KEYS.includes(value as SectionKey);

export function SettingsPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settingsQuery = useSettingsQuery();
  const tasksQuery = useTasksQuery();
  const jobsQuery = useJobsQuery();
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM);
  const settings = useMemo(() => view(form), [form]);
  const dirty = isDirty(form);
  const transcriptionHealthQuery = useTranscriptionHealthQuery(Boolean(str(settings.transcription_backend_url)));
  const [saving, setSaving] = useState(false);
  const [testingTranscription, setTestingTranscription] = useState(false);
  const [transcriptionTestResult, setTranscriptionTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingNotification, setTestingNotification] = useState(false);
  const [notificationTestResult, setNotificationTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // ?section=youtube lets other pages link straight to a section.
  const [params] = useSearchParams();
  const requestedSection = params.get("section");
  const [activeSection, setActiveSection] = useState<SectionKey>(isSectionKey(requestedSection) ? requestedSection : "llm");

  // Synchronous mirror of `form` so rapid update()/updateAndSave() calls in the
  // same tick build on each other instead of overwriting from a stale render closure.
  const formRef = useRef<SettingsForm>(EMPTY_FORM);
  // Serializes save POSTs so the last-issued (most complete) body is also the last write.
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  // Debounce timer for autosaved free-text fields (LLM / Engine), so typing
  // coalesces into one POST instead of one per keystroke.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyForm = (next: SettingsForm) => {
    formRef.current = next;
    setForm(next);
  };

  // A refetch (scan:complete invalidation, window focus) only replaces the
  // server snapshot; keys the user is still editing keep their local value.
  useEffect(() => {
    if (settingsQuery.data) applyForm(receiveServer(formRef.current, settingsQuery.data));
  }, [settingsQuery.data]);

  // Silent predicate: are both JSON-blob settings well-formed in `s`?
  const jsonBlobsValid = (s: Record<string, unknown>): boolean =>
    (Object.keys(JSON_BLOB_SETTINGS) as JsonBlobSettingKey[]).every(
      (key) => validateJsonSetting(key, getStr(s, key)).ok
    );

  // Every save goes through here. Resolves true when `body` reached the server;
  // a malformed JSON blob is never persisted and the edits stay pending so the
  // value isn't lost (handleSave surfaces the toast on an explicit save).
  const persist = (body: Record<string, unknown>): Promise<boolean> => {
    if (!jsonBlobsValid(body)) return Promise.resolve(false);
    saveChainRef.current = saveChainRef.current
      .then(() => api.saveSettings(body))
      .then(() => {
        applyForm(saved(formRef.current, body));
        // The App-level settings cache feeds the sidebar (model name, watcher
        // state); without this it keeps the pre-save values until an unrelated
        // event refetches, so the sidebar lagged the model switch.
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
        return true;
      })
      .catch((e: unknown) => {
        // Edits stay pending, and the failure is surfaced instead of swallowed
        // (debounced autosaves otherwise fail silently).
        addToast(t("settings.saveFailed", { message: getErrorMessage(e) }), "error");
        return false;
      });
    return saveChainRef.current;
  };

  const update = (key: string, value: unknown) => {
    applyForm(edit(formRef.current, key, value));
  };

  const updateAndSave = async (key: string, value: unknown) => {
    applyForm(edit(formRef.current, key, value));
    await persist(view(formRef.current));
  };

  const updateManyAndSave = async (updates: Record<string, unknown>) => {
    applyForm(editMany(formRef.current, updates));
    await persist(view(formRef.current));
  };

  const clearSaveTimer = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  };

  // Autosave with debounce — for LLM/Engine fields incl. free-text inputs.
  const updateAndSaveDebounced = (key: string, value: unknown, delay = 500) => {
    applyForm(edit(formRef.current, key, value));
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persist(view(formRef.current));
    }, delay);
  };

  // Validate the two JSON-blob settings (folder defaults + advanced STT) before
  // any save. On failure we toast and DO NOT persist the malformed value.
  // Returns true when all blobs are valid, false when a save should be blocked.
  const validateJsonBlobs = (): boolean => {
    for (const key of Object.keys(JSON_BLOB_SETTINGS) as JsonBlobSettingKey[]) {
      const result = validateJsonSetting(key, getStr(view(formRef.current), key));
      if (!result.ok) {
        const label = t(`settings.transcription.${key === "transcription_folder_defaults" ? "folderDefaults" : "advancedOptions"}`);
        addToast(t("settings.invalidJson", { field: label }), "error");
        return false;
      }
    }
    return true;
  };

  // Leaving the page flushes whatever is still unsaved: a pending debounced
  // autosave, and the deferred fields that normally wait for the topbar Save.
  useEffect(() => () => {
    clearSaveTimer();
    if (isDirty(formRef.current) && validateJsonBlobs()) void persist(view(formRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (): Promise<boolean> => {
    if (!validateJsonBlobs()) return false;
    clearSaveTimer();
    setSaving(true);
    if (await persist(view(formRef.current))) addToast(t("settings.saved"), "success");
    setSaving(false);
    return true;
  };

  // Tests run against saved settings, so pending edits are flushed first.
  const flushBeforeTest = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (!validateJsonBlobs()) return false;
    clearSaveTimer();
    return persist(view(formRef.current));
  };

  const handleTranscriptionTest = async () => {
    setTestingTranscription(true);
    setTranscriptionTestResult(null);
    try {
      if (!(await flushBeforeTest())) { setTestingTranscription(false); return; }
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
      if (!(await flushBeforeTest())) { setTestingNotification(false); return; }
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

  // The watcher flag is server state, not a user edit: it changes the snapshot
  // underneath any pending edits instead of becoming one of them.
  const setWatcherRunning = (running: boolean) =>
    applyForm(receiveServer(formRef.current, { ...formRef.current.server, _watcher_running: running }));

  const toggleWatcher = async () => {
    try {
      if (settings._watcher_running) {
        await api.stopWatcher();
        setWatcherRunning(false);
        // The sidebar's watcher dot reads the shared settings cache; without
        // this it lagged the toggle for up to 30s.
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
        addToast(t("settings.watcherStopped"), "info");
      } else {
        await api.startWatcher();
        setWatcherRunning(true);
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
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
    youtube: {
      navLabel: t("settings.youtube.title"),
      title: t("settings.youtube.title"),
      description: t("settings.youtube.description"),
      content: <YoutubeSection settings={settings} update={update} updateAndSaveDebounced={updateAndSaveDebounced} />,
    },
    iface: {
      navLabel: t("settings.interface.title"),
      title: t("settings.interface.title"),
      description: t("settings.interface.description"),
      content: <InterfaceSection />,
    },
  };
  const navOrder: readonly SectionKey[] = SECTION_KEYS;

  // First-run signposting. Both queries are already in the app-level cache, so
  // this costs no extra requests. Copy is shared with the Dashboard checklist
  // rather than duplicated — see SetupProgress for why this isn't a wizard.
  const enabledTaskCount = (tasksQuery.data || []).filter((task) => task.enabled === 1).length;
  // The jobs list is transient — Clear finished empties it, and a rescan then
  // creates no jobs (outputs exist), so a jobs-based step would never clear
  // again. The server's sticky flag says media was discovered at least once.
  const hasDiscoveredMedia =
    (jobsQuery.data?.jobs || []).length > 0 || str(settings.media_scanned) === "1";
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

      {/* One max width for the checklist and the nav + panel grid, so the
          checklist does not run past the column it introduces. */}
      <div className="max-w-[920px] flex-1 p-3.5 md:p-[18px]">
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
              <Accordion key={key} title={sectionMeta[key].title} defaultOpen={key === activeSection}>
                <div className="space-y-4">
                  <p className="text-[11.5px] leading-6 text-[var(--text-2)]">{sectionMeta[key].description}</p>
                  {sectionMeta[key].content}
                </div>
              </Accordion>
            ))}
          </div>
        ) : (
          <div className="grid gap-[18px] md:grid-cols-[185px_1fr]">
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
