import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import {
  LLM_STATUS_QUERY_KEY,
  useJobsQuery,
  useSettingsQuery,
  useTasksQuery,
  useTranscriptionHealthQuery,
  useIsMobile,
} from "../../hooks";
import { SetupProgress, type SetupStep } from "./SetupProgress";
import { useToast } from "../../ui/Toast";
import { Accordion, ActionButton, SettingsSection, PageHeader } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { JSON_BLOB_SETTINGS, getStr, validateJsonSetting, type JsonBlobSettingKey } from "./settings-model";
import { str } from "../../lib/settings-value";
import {
  changes,
  EMPTY_FORM,
  edit,
  editMany,
  isDirty,
  receiveServer,
  saved,
  sendFailed,
  sending,
  view,
  type SettingsForm,
} from "./settings-form";
import { EngineSection } from "./sections/EngineSection";
import { CorrectionsSection } from "./sections/CorrectionsSection";
import { InterfaceSection } from "./sections/InterfaceSection";
import { LlmSection } from "./sections/LlmSection";
import { SourcesSection } from "./sections/SourcesSection";
import { SttSection } from "./sections/SttSection";
import { YoutubeSection } from "./sections/YoutubeSection";
import { SettingsSubpageLinks } from "./SettingsSubpageLinks";
import { ConfigLoadErrorBanner, configLoadFailureOf } from "./ConfigLoadErrorBanner";
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_KEYS,
  settingsSection,
  type SettingsSectionKey,
} from "./settings-navigation";

/** saved: written as sent. rejected: written, minus keys the server refused. failed: nothing written. */
type SaveOutcome = "saved" | "rejected" | "failed";

export function SettingsPage() {
  const isMobile = useIsMobile();
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
  const configLoadFailure = configLoadFailureOf(settings);
  const transcriptionHealthQuery = useTranscriptionHealthQuery(Boolean(str(settings.transcription_backend_url)));
  const [saving, setSaving] = useState(false);
  const [testingTranscription, setTestingTranscription] = useState(false);
  const [transcriptionTestResult, setTranscriptionTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingNotification, setTestingNotification] = useState(false);
  const [notificationTestResult, setNotificationTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // ?section=youtube lets other pages link straight to a section.
  const [params] = useSearchParams();
  const activeSection = settingsSection(params.get("section"));

  // Synchronous mirror of `form` so rapid update()/updateAndSave() calls in the
  // same tick build on each other instead of overwriting from a stale render closure.
  const formRef = useRef<SettingsForm>(EMPTY_FORM);
  // Serializes save POSTs so the last-issued (most complete) body is also the last write.
  const saveChainRef = useRef<Promise<SaveOutcome>>(Promise.resolve("saved"));
  // Debounce timer for autosaved free-text fields (LLM / Engine), so typing
  // coalesces into one POST instead of one per keystroke.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyForm = (next: SettingsForm) => {
    formRef.current = next;
    setForm(next);
  };

  // A refetch (scan:complete invalidation, window focus) only replaces the
  // server snapshot; keys the user is still editing keep their local value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the server snapshot changes; applyForm only writes refs and state
  useEffect(() => {
    if (settingsQuery.data) applyForm(receiveServer(formRef.current, settingsQuery.data));
  }, [settingsQuery.data]);

  // Silent predicate: are both JSON-blob settings well-formed in `s`?
  const jsonBlobsValid = (s: Record<string, unknown>): boolean =>
    (Object.keys(JSON_BLOB_SETTINGS) as JsonBlobSettingKey[]).every(
      (key) => validateJsonSetting(key, getStr(s, key)).ok,
    );

  // Every save goes through here. Resolves true when `body` reached the server;
  // a malformed JSON blob is never persisted and the edits stay pending so the
  // value isn't lost (handleSave surfaces the toast on an explicit save).
  const persist = (): Promise<SaveOutcome> => {
    if (!jsonBlobsValid(view(formRef.current))) return Promise.resolve("failed");
    const body = changes(formRef.current);
    applyForm(sending(formRef.current));
    saveChainRef.current = saveChainRef.current
      .then(() => api.saveSettings(body))
      .then((result): SaveOutcome => {
        applyForm(saved(formRef.current, body));
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
        void queryClient.invalidateQueries({ queryKey: LLM_STATUS_QUERY_KEY });
        // The server keeps its value for these (an env-pinned key, say); the
        // refetch above shows it, and the toast says why the edit did not stick.
        const rejected = result?.rejected ?? [];
        if (rejected.length === 0) return "saved";
        addToast(t("settings.rejectedKeys", { keys: rejected.join(", ") }), "error");
        return "rejected";
      })
      .catch((e: unknown): SaveOutcome => {
        applyForm(sendFailed(formRef.current));
        // Edits stay pending, and the failure is surfaced instead of swallowed
        // (debounced autosaves otherwise fail silently).
        addToast(t("settings.saveFailed", { message: getErrorMessage(e) }), "error");
        return "failed";
      });
    return saveChainRef.current;
  };

  const update = (key: string, value: unknown) => {
    applyForm(edit(formRef.current, key, value));
  };

  const updateAndSave = async (key: string, value: unknown): Promise<SaveOutcome> => {
    applyForm(edit(formRef.current, key, value));
    return persist();
  };

  const updateManyAndSave = async (updates: Record<string, unknown>) => {
    applyForm(editMany(formRef.current, updates));
    await persist();
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
      void persist();
    }, delay);
  };

  // Validate the two JSON-blob settings (folder defaults + advanced STT) before
  // any save. On failure we toast and DO NOT persist the malformed value.
  // Returns true when all blobs are valid, false when a save should be blocked.
  const validateJsonBlobs = (): boolean => {
    for (const key of Object.keys(JSON_BLOB_SETTINGS) as JsonBlobSettingKey[]) {
      const result = validateJsonSetting(key, getStr(view(formRef.current), key));
      if (!result.ok) {
        const label = t(
          `settings.transcription.${key === "transcription_folder_defaults" ? "folderDefaults" : "advancedOptions"}`,
        );
        addToast(t("settings.invalidJson", { field: label }), "error");
        return false;
      }
    }
    return true;
  };

  // Leaving the page flushes whatever is still unsaved: a pending debounced
  // autosave, and the deferred fields that normally wait for the topbar Save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flushes on unmount only, reading the latest form through refs
  useEffect(
    () => () => {
      clearSaveTimer();
      if (isDirty(formRef.current) && validateJsonBlobs()) void persist();
    },
    [],
  );

  const handleSave = async (): Promise<boolean> => {
    if (!validateJsonBlobs()) return false;
    clearSaveTimer();
    setSaving(true);
    if ((await persist()) === "saved") addToast(t("settings.saved"), "success");
    setSaving(false);
    return true;
  };

  // Tests run against saved settings, so pending edits are flushed first.
  const flushBeforeTest = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (!validateJsonBlobs()) return false;
    clearSaveTimer();
    return (await persist()) !== "failed";
  };

  const handleTranscriptionTest = async () => {
    setTestingTranscription(true);
    setTranscriptionTestResult(null);
    try {
      if (!(await flushBeforeTest())) {
        setTestingTranscription(false);
        return;
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
      if (!(await flushBeforeTest())) {
        setTestingNotification(false);
        return;
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
  const sectionMeta: Record<SettingsSectionKey, { description: string; content: ReactNode }> = {
    llm: {
      description: t("settings.llmConnection.description"),
      content: <LlmSection settings={settings} updateAndSaveDebounced={updateAndSaveDebounced} addToast={addToast} />,
    },
    engine: {
      description: t("settings.translationEngine.description"),
      content: <EngineSection settings={settings} updateAndSaveDebounced={updateAndSaveDebounced} />,
    },
    corrections: {
      description: t("settings.corrections.description"),
      content: <CorrectionsSection settings={settings} updateAndSave={updateAndSave} />,
    },
    sources: {
      description: t("settings.sources.description"),
      content: (
        <SourcesSection
          settings={settings}
          update={update}
          updateAndSave={updateAndSave}
          updateManyAndSave={updateManyAndSave}
          updateAndSaveDebounced={updateAndSaveDebounced}
          onNotificationTest={handleNotificationTest}
          testingNotification={testingNotification}
          notificationTestResult={notificationTestResult}
        />
      ),
    },
    stt: {
      description: t("settings.transcription.description"),
      content: (
        <SttSection
          settings={settings}
          tasks={tasksQuery.data ?? []}
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
      description: t("settings.youtube.description"),
      content: <YoutubeSection settings={settings} update={update} updateAndSaveDebounced={updateAndSaveDebounced} />,
    },
    iface: {
      description: t("settings.interface.description"),
      content: (
        <InterfaceSection
          subtitleWarnings={settings.show_subtitle_warnings === "1"}
          onSubtitleWarningsChange={(checked) => void updateAndSave("show_subtitle_warnings", checked ? "1" : "0")}
        />
      ),
    },
  };

  // First-run signposting. Both queries are already in the app-level cache, so
  // this costs no extra requests. Copy is shared with the Dashboard checklist
  // rather than duplicated — see SetupProgress for why this isn't a wizard.
  const enabledTaskCount = (tasksQuery.data || []).filter((task) => task.enabled === 1).length;
  // The jobs list is transient — Clear finished empties it, and a rescan then
  // creates no jobs (outputs exist), so a jobs-based step would never clear
  // again. The server's sticky flag says media was discovered at least once.
  const hasDiscoveredMedia = (jobsQuery.data?.jobs || []).length > 0 || str(settings.media_scanned) === "1";
  const setupSteps: SetupStep[] = [
    {
      key: "llm",
      done: settings._llm_configured === true,
      title: t("dashboard.quickStart.llmTitle"),
      hint: t("dashboard.quickStart.llmHint"),
      actionLabel: t("settings.setup.goToSection"),
      // Already in Settings — jump to the section rather than navigating away.
      onAction: () => navigate("/settings"),
    },
    {
      key: "tasks",
      done: enabledTaskCount > 0,
      title: t("dashboard.quickStart.tasksTitle"),
      hint: t("dashboard.quickStart.tasksHint"),
      actionLabel: t("dashboard.quickStart.openTranslations"),
      onAction: () => navigate("/settings/languages"),
    },
    {
      key: "media",
      done: hasDiscoveredMedia,
      title: t("dashboard.quickStart.mediaTitle"),
      hint: t("dashboard.quickStart.mediaHint"),
      actionLabel: t("dashboard.quickStart.scanNow"),
      // Scanning lives in the Library; don't duplicate the action here.
      onAction: () => navigate("/"),
    },
  ];

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={t("settings.title")}
        actions={
          <>
            {dirty && <span className="text-xs text-warning">{t("common.unsavedChanges")}</span>}
            <ActionButton size="sm" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? t("app.saving") : t("app.save")}
            </ActionButton>
          </>
        }
      />

      <div className="w-full max-w-5xl flex-1 p-4">
        {settingsQuery.isError && (
          <div className="mb-4">
            <InlineError onRetry={() => void settingsQuery.refetch()} />
          </div>
        )}
        {configLoadFailure && (
          <div className="mb-4">
            <ConfigLoadErrorBanner failure={configLoadFailure} />
          </div>
        )}
        <SetupProgress steps={setupSteps} />
        {isMobile ? (
          <div key={activeSection} className="space-y-3">
            {/* The pages of their own come first: below, an open section can run several screens long. */}
            <SettingsSubpageLinks variant="rows" />
            {SETTINGS_SECTION_KEYS.map((key) => (
              <Accordion key={key} title={t(SETTINGS_SECTIONS[key])} defaultOpen={key === activeSection}>
                <div className="space-y-4">
                  <p className="text-xs leading-6 text-muted">{sectionMeta[key].description}</p>
                  {sectionMeta[key].content}
                </div>
              </Accordion>
            ))}
          </div>
        ) : (
          <SettingsSection
            title={t(SETTINGS_SECTIONS[activeSection])}
            description={sectionMeta[activeSection].description}
          >
            {sectionMeta[activeSection].content}
          </SettingsSection>
        )}

        <p className="pt-4 text-center text-xs text-faint">
          {t("settings.about.version", { version: __APP_VERSION__ })}
        </p>
      </div>
    </div>
  );
}
