import { useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ToastProvider, useToast } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmModal";
import { formatDur } from "./lib";
import { useIsMobile, useJobsQuery, useQueueStatusQuery, useSSE, useSettingsQuery } from "./hooks";
import type { JobRow } from "./types";
import { DesktopSidebar, MobileBottomNav, TopStatusBar } from "./app/shell";
import { DashboardPage } from "./features/dashboard";
import { LogsPage } from "./features/logs/LogsPage";
import { JobDetailPage } from "./features/jobs/JobDetailPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { SettingsPage } from "./features/settings/SettingsPage";

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const jobsQuery = useJobsQuery();
  const settingsQuery = useSettingsQuery();
  const queueQuery = useQueueStatusQuery();
  const location = useLocation();

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
      addToast(
        t("dashboard.toast.jobFailed", {
          name: String(data.srtName ?? ""),
          error: String(data.error ?? ""),
        }),
        "error",
        true,
      );
    }
    if (type === "queue:finished") addToast(t("dashboard.toast.queueFinished"), "success");
    if (type === "queue:stopped") addToast(t("dashboard.toast.queueStopped"), "info");
  });

  const queueRunning = jobsQuery.data?.queueRunning || false;
  const errorCount = jobsQuery.data?.jobs?.filter((j: JobRow) => j.status === "error").length || 0;
  const modelName = typeof settingsQuery.data?.model === "string" ? settingsQuery.data.model : "";
  const watcherRunning =
    Boolean(queueQuery.data?.watcherRunning) || Boolean(settingsQuery.data?._watcher_running);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {!isMobile && (
        <DesktopSidebar
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          queueRunning={queueRunning}
          errorCount={errorCount}
          modelName={modelName}
          watcherRunning={watcherRunning}
          currentPath={location.pathname}
          onLanguageChange={(code) => i18n.changeLanguage(code)}
          currentLanguage={i18n.language}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStatusBar queueRunning={queueRunning} watcherRunning={watcherRunning} modelName={modelName} />
        <main className={`flex-1 overflow-auto ${isMobile ? "pb-24" : ""}`}>
          <Routes>
            <Route path="/" element={<DashboardPage isMobile={isMobile} />} />
            <Route path="/tasks" element={<TasksPage isMobile={isMobile} />} />
            <Route path="/settings" element={<SettingsPage isMobile={isMobile} />} />
            <Route path="/logs" element={<LogsPage isMobile={isMobile} />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
          </Routes>
        </main>
        {isMobile && <MobileBottomNav currentPath={location.pathname} />}
      </div>
    </div>
  );
}
