import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ToastProvider, useToast } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmModal";
import { formatDur } from "./lib";
import { applyTheme, getThemePref, watchSystemTheme } from "./lib/theme";
import { applyFontScale, getFontScale } from "./lib/font-scale";
import {
  useIsMobile,
  useJobsQuery,
  useQueueStatusQuery,
  useSSE,
  useSettingsQuery,
} from "./hooks";
import type { JobRow } from "./types";
import { DesktopSidebar, MobileBottomNav } from "./app/shell";
import { LANGUAGES } from "./app/constants";
import { DashboardPage } from "./features/dashboard";

const LogsPage = lazy(() =>
  import("./features/logs/LogsPage").then((m) => ({ default: m.LogsPage })),
);
const JobDetailPage = lazy(() =>
  import("./features/jobs/JobDetailPage").then((m) => ({
    default: m.JobDetailPage,
  })),
);
const TranslationLanguagesPage = lazy(() =>
  import("./features/tasks/TasksPage").then((m) => ({
    default: m.TranslationLanguagesPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./features/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
  })),
);
const ConvertPage = lazy(() =>
  import("./features/convert/ConvertPage").then((m) => ({
    default: m.ConvertPage,
  })),
);
const YoutubePage = lazy(() =>
  import("./features/youtube/YoutubePage").then((m) => ({
    default: m.YoutubePage,
  })),
);
const WhisperPage = lazy(() =>
  import("./features/whisper/WhisperPage").then((m) => ({
    default: m.WhisperPage,
  })),
);

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppInner />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AppInner() {
  const { addToast } = useToast();
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const jobsQuery = useJobsQuery();
  const settingsQuery = useSettingsQuery();
  const queueQuery = useQueueStatusQuery();
  const location = useLocation();
  const navigate = useNavigate();
  // Failures since the user last dismissed the failure toast. They collapse
  // into one toast that counts up, instead of one persistent toast per job.
  const failedJobsRef = useRef(0);

  useSSE((type, data) => {
    if (type === "job:done") {
      addToast(
        t("dashboard.toast.jobComplete", {
          name: String(data.srtName ?? ""),
          lang: String(data.langCode ?? ""),
          dur: formatDur(Number(data.durationSeconds ?? 0)),
        }),
        "success",
      );
    }
    if (type === "job:error") {
      failedJobsRef.current += 1;
      const count = failedJobsRef.current;
      addToast(
        count === 1
          ? t("dashboard.toast.jobFailed", { name: String(data.srtName ?? ""), error: String(data.error ?? "") })
          : t("dashboard.toast.jobsFailed", { count }),
        "error",
        {
          persistent: true,
          key: "job:error",
          action: { label: t("dashboard.toast.openDashboard"), onClick: () => navigate("/") },
          onDismiss: () => { failedJobsRef.current = 0; },
        },
      );
    }
    if (type === "queue:finished")
      addToast(t("dashboard.toast.queueFinished"), "success");
    if (type === "queue:stopped")
      addToast(t("dashboard.toast.queueStopped"), "info");
  });

  const queueRunning = Boolean(
    queueQuery.data?.running ?? jobsQuery.data?.queueRunning ?? false,
  );
  const errorCount =
    jobsQuery.data?.jobs?.filter((j: JobRow) => j.status === "error").length ||
    0;
  const modelName =
    typeof settingsQuery.data?.model === "string"
      ? settingsQuery.data.model
      : "";
  const watcherRunning =
    Boolean(queueQuery.data?.watcherRunning) ||
    Boolean(settingsQuery.data?._watcher_running);

  useEffect(() => {
    const current = LANGUAGES.find(
      (lang) =>
        i18n.language === lang.code ||
        i18n.language.startsWith(`${lang.code}-`),
    );
    document.documentElement.dir = current?.dir || "ltr";
    document.documentElement.lang = current?.code || "en";
  }, [i18n.language]);

  // Apply the stored theme and follow OS scheme changes while on "system".
  useEffect(() => {
    applyTheme(getThemePref());
    applyFontScale(getFontScale());
    return watchSystemTheme(() => {
      if (getThemePref() === "system") applyTheme("system");
    });
  }, []);

  return (
    <div className="flex h-dvh min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      {!isMobile && (
        <DesktopSidebar
          queueRunning={queueRunning}
          errorCount={errorCount}
          modelName={modelName}
          watcherRunning={watcherRunning}
          currentPath={location.pathname}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className={`flex-1 overflow-auto ${isMobile ? "pb-[58px]" : ""}`}>
          <Suspense
            fallback={
              <div className="p-8 text-[var(--text-3)]">
                {t("common.loading")}
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<DashboardPage isMobile={isMobile} />} />
              <Route
                path="/translations"
                element={<TranslationLanguagesPage isMobile={isMobile} />}
              />
              <Route
                path="/whisper"
                element={<WhisperPage isMobile={isMobile} />}
              />
              <Route
                path="/youtube"
                element={<YoutubePage isMobile={isMobile} />}
              />
              <Route
                path="/convert"
                element={<ConvertPage isMobile={isMobile} />}
              />
              <Route
                path="/tasks"
                element={<Navigate to="/translations" replace />}
              />
              <Route
                path="/settings"
                element={<SettingsPage isMobile={isMobile} />}
              />
              <Route path="/logs" element={<LogsPage isMobile={isMobile} />} />
              <Route path="/jobs/:id" element={<JobDetailPage />} />
            </Routes>
          </Suspense>
        </main>
        {isMobile && <MobileBottomNav currentPath={location.pathname} />}
      </div>
    </div>
  );
}
