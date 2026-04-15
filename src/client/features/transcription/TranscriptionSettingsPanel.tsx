import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useToast } from "../../components/Toast";
import { useTranscriptionJobsQuery } from "../../hooks";
import { ActionButton, Field, ProgressSmall, SettingsSection } from "../../ui/primitives";
import type {
  TranscriptionJob,
  WhisperHealth,
  WhisperModelEntry,
  WhisperModelsResponse,
} from "../../types";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

interface Props {
  settings: Record<string, unknown>;
  update: (key: string, value: unknown) => void;
  updateAndSave: (key: string, value: unknown) => Promise<void>;
  isMobile: boolean;
}

export function TranscriptionSettingsPanel({
  settings,
  update,
  updateAndSave,
  isMobile,
}: Props) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<WhisperHealth | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<WhisperModelsResponse | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [downloadPickerOpen, setDownloadPickerOpen] = useState<null | "whisper" | "uvr">(null);

  const enabled = str(settings.whisper_enabled, "0") === "1";
  const transcriptionJobs = useTranscriptionJobsQuery();
  const downloadsInFlight = useMemo(
    () =>
      (transcriptionJobs.data?.jobs || []).filter(
        (j: TranscriptionJob) => j.kind === "download" && (j.status === "running" || j.status === "pending")
      ),
    [transcriptionJobs.data]
  );

  const refreshModels = async () => {
    if (!enabled) return;
    setLoadingModels(true);
    try {
      const data = await api.listWhisperModels();
      setModels(data);
    } catch (e: unknown) {
      addToast(t("transcription.settings.modelsError", { message: getErrorMessage(e) }), "error");
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (enabled && !models && !loadingModels) void refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const handleTest = async () => {
    setTesting(true);
    setTestError(null);
    setHealth(null);
    try {
      const result = await api.testWhisperConnection();
      if (result.ok && result.health) {
        setHealth(result.health);
        addToast(t("transcription.settings.testOk"), "success");
        await refreshModels();
      } else {
        const message = result.error || t("transcription.settings.unknownError");
        setTestError(message);
        addToast(t("transcription.settings.testFailed", { message }), "error");
      }
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      setTestError(message);
      addToast(t("transcription.settings.testFailed", { message }), "error");
    } finally {
      setTesting(false);
    }
  };

  const handleDownload = async (kind: "whisper" | "uvr", name: string) => {
    try {
      await api.downloadWhisperModel(kind, name);
      addToast(t("transcription.settings.downloadStarted", { name }), "info");
      setDownloadPickerOpen(null);
    } catch (e: unknown) {
      addToast(t("transcription.settings.downloadFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const handleDelete = async (kind: "whisper" | "uvr", name: string) => {
    try {
      await api.deleteWhisperModel(kind, name);
      addToast(t("transcription.settings.deleted", { name }), "info");
      await refreshModels();
    } catch (e: unknown) {
      addToast(t("transcription.settings.deleteFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const handleRotate = async () => {
    try {
      const result = await api.rotateWhisperKey();
      update("whisper_api_key", result.apiKey);
      addToast(t("transcription.settings.keyRotated"), "success");
    } catch (e: unknown) {
      addToast(t("transcription.settings.rotateFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const whisperCached: WhisperModelEntry[] = models?.whisper.cached || [];
  const whisperCatalog: WhisperModelEntry[] = models?.whisper.catalog || [];
  const uvrCached: WhisperModelEntry[] = models?.uvr.cached || [];
  const uvrCatalog: WhisperModelEntry[] = models?.uvr.catalog || [];

  return (
    <SettingsSection
      title={t("transcription.settings.title")}
      description={t("transcription.settings.description")}
    >
      <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
        <div>
          <p className="text-sm font-medium text-gray-300">
            {t("transcription.settings.enable")}
          </p>
          <p className="mt-0.5 text-[10px] text-gray-500">
            {t("transcription.settings.enableHint")}
          </p>
        </div>
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
          checked={enabled}
          onChange={(e) => updateAndSave("whisper_enabled", e.target.checked ? "1" : "0")}
        />
      </label>

      <Field
        label={t("transcription.settings.endpoint")}
        value={str(settings.whisper_endpoint)}
        onChange={(v) => update("whisper_endpoint", v)}
        placeholder="http://localhost:9000"
        help={t("transcription.settings.endpointHint")}
      />

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-gray-300">
            {t("transcription.settings.apiKey")}
          </label>
          <button onClick={handleRotate} className="text-[10px] text-blue-400">
            {t("transcription.settings.rotateKey")}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type={showApiKey ? "text" : "password"}
            value={str(settings.whisper_api_key)}
            onChange={(e) => update("whisper_api_key", e.target.value)}
            placeholder={t("transcription.settings.apiKeyPlaceholder")}
            className="flex-1 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
          />
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="rounded-2xl border border-gray-700 bg-gray-800 px-4 py-3 text-xs text-gray-400"
          >
            {showApiKey ? "🙈" : "👁"}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-gray-600">
          {t("transcription.settings.apiKeyHint")}
        </p>
      </div>

      <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
        <ActionButton variant="ghost" onClick={handleTest} busy={testing} disabled={!enabled}>
          {testing ? t("app.testing") : t("app.testConnection")}
        </ActionButton>
        {testError && <span className="text-sm text-red-400">{testError}</span>}
      </div>

      {health && (
        <div className="grid gap-2 rounded-2xl bg-gray-800/40 p-4 text-[11px] text-gray-300 md:grid-cols-2">
          <div>
            <span className="text-gray-500">{t("transcription.settings.device")}:</span>{" "}
            <span className="font-mono">{health.device}</span>{" "}
            <span className="text-gray-500">({health.compute_type})</span>
          </div>
          <div>
            <span className="text-gray-500">GPU:</span>{" "}
            <span className="font-mono">{health.gpu_name || "CPU"}</span>
          </div>
          <div>
            <span className="text-gray-500">VRAM free:</span>{" "}
            <span className="font-mono">{humanSize(health.vram_free_bytes || 0)}</span>
          </div>
          <div>
            <span className="text-gray-500">{t("transcription.settings.mediaDir")}:</span>{" "}
            <span className="font-mono break-all">{health.media_dir}</span>
          </div>
          <div className="md:col-span-2">
            <span className="text-gray-500">{t("transcription.settings.modelsDir")}:</span>{" "}
            <span className="font-mono break-all">{health.models_dir}</span>
          </div>
        </div>
      )}

      {enabled && (
        <>
          <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                {t("transcription.settings.model")}
              </label>
              <div className="flex gap-2">
                <select
                  value={str(settings.whisper_model)}
                  onChange={(e) => update("whisper_model", e.target.value)}
                  className="flex-1 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
                >
                  {whisperCached.length === 0 && (
                    <option value={str(settings.whisper_model)}>
                      {str(settings.whisper_model) || t("transcription.settings.noModelsCached")}
                    </option>
                  )}
                  {whisperCached.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} · {humanSize(m.size_bytes)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={refreshModels}
                  className="rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-xs text-gray-300"
                  title={t("transcription.settings.refreshModels")}
                >
                  {loadingModels ? "…" : "↻"}
                </button>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <p className="text-[10px] text-gray-600">
                  {t("transcription.settings.modelHint")}
                </p>
                <button
                  type="button"
                  onClick={() => setDownloadPickerOpen("whisper")}
                  className="text-[10px] text-blue-400"
                >
                  {t("transcription.settings.downloadModel")}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                {t("transcription.settings.language")}
              </label>
              <input
                type="text"
                value={str(settings.whisper_language)}
                onChange={(e) => update("whisper_language", e.target.value)}
                placeholder={t("transcription.settings.languagePlaceholder")}
                className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
              />
              <p className="mt-1 text-[10px] text-gray-600">
                {t("transcription.settings.languageHint")}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                {t("transcription.settings.task")}
              </label>
              <select
                value={str(settings.whisper_task, "transcribe")}
                onChange={(e) => update("whisper_task", e.target.value)}
                className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
              >
                <option value="transcribe">{t("transcription.settings.taskTranscribe")}</option>
                <option value="translate">{t("transcription.settings.taskTranslate")}</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                {t("transcription.settings.outputFormat")}
              </label>
              <select
                value={str(settings.whisper_output_format, "srt")}
                onChange={(e) => update("whisper_output_format", e.target.value)}
                className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
              >
                <option value="srt">SRT</option>
                <option value="vtt">WebVTT</option>
                <option value="txt">Plain text</option>
              </select>
            </div>
          </div>

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">
                {t("transcription.settings.vad")}
              </p>
              <p className="mt-0.5 text-[10px] text-gray-500">
                {t("transcription.settings.vadHint")}
              </p>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              checked={str(settings.whisper_vad_enabled, "1") === "1"}
              onChange={(e) => updateAndSave("whisper_vad_enabled", e.target.checked ? "1" : "0")}
            />
          </label>

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">
                {t("transcription.settings.uvr")}
              </p>
              <p className="mt-0.5 text-[10px] text-gray-500">
                {t("transcription.settings.uvrHint")}
              </p>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              checked={str(settings.whisper_uvr_enabled, "0") === "1"}
              onChange={(e) => updateAndSave("whisper_uvr_enabled", e.target.checked ? "1" : "0")}
            />
          </label>

          {str(settings.whisper_uvr_enabled, "0") === "1" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                {t("transcription.settings.uvrModel")}
              </label>
              <div className="flex gap-2">
                <select
                  value={str(settings.whisper_uvr_model)}
                  onChange={(e) => update("whisper_uvr_model", e.target.value)}
                  className="flex-1 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
                >
                  {uvrCached.length === 0 && (
                    <option value={str(settings.whisper_uvr_model)}>
                      {str(settings.whisper_uvr_model) || t("transcription.settings.noModelsCached")}
                    </option>
                  )}
                  {uvrCached.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} · {humanSize(m.size_bytes)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setDownloadPickerOpen("uvr")}
                  className="rounded-2xl bg-gray-800 px-3 py-3 text-xs text-gray-300"
                >
                  {t("transcription.settings.downloadModel")}
                </button>
              </div>
            </div>
          )}

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-gray-800/50 p-4">
            <div>
              <p className="text-sm font-medium text-gray-300">
                {t("transcription.settings.autoTranslate")}
              </p>
              <p className="mt-0.5 text-[10px] text-gray-500">
                {t("transcription.settings.autoTranslateHint")}
              </p>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              checked={str(settings.auto_translate_after_transcribe, "0") === "1"}
              onChange={(e) =>
                updateAndSave("auto_translate_after_transcribe", e.target.checked ? "1" : "0")
              }
            />
          </label>

          {downloadsInFlight.length > 0 && (
            <div className="rounded-2xl bg-blue-950/30 p-4">
              <p className="mb-2 text-sm font-medium text-blue-200">
                {t("transcription.settings.activeDownloads")}
              </p>
              <ul className="space-y-2">
                {downloadsInFlight.map((job) => (
                  <li key={job.id} className="text-[11px] text-gray-300">
                    <div className="flex items-center justify-between">
                      <span className="font-mono">
                        {job.model_kind}/{job.model_name}
                      </span>
                      <span className="text-blue-300">
                        {Math.round((job.progress || 0) * 100)}%
                      </span>
                    </div>
                    <ProgressSmall pct={Math.round((job.progress || 0) * 100)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-2xl bg-gray-800/40 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-300">
                {t("transcription.settings.cachedModels")}
              </p>
              <button onClick={refreshModels} className="text-[10px] text-blue-400">
                {loadingModels ? t("common.loading") : t("transcription.settings.refresh")}
              </button>
            </div>
            <CacheTable
              title="Whisper"
              items={whisperCached}
              onDelete={(name) => void handleDelete("whisper", name)}
            />
            <CacheTable
              title="UVR"
              items={uvrCached}
              onDelete={(name) => void handleDelete("uvr", name)}
            />
          </div>
        </>
      )}

      {downloadPickerOpen && (
        <DownloadPickerModal
          kind={downloadPickerOpen}
          catalog={downloadPickerOpen === "whisper" ? whisperCatalog : uvrCatalog}
          cachedNames={
            new Set(
              (downloadPickerOpen === "whisper" ? whisperCached : uvrCached).map((m) => m.name)
            )
          }
          onDownload={(name) => void handleDownload(downloadPickerOpen, name)}
          onClose={() => setDownloadPickerOpen(null)}
        />
      )}
    </SettingsSection>
  );
}

function CacheTable({
  title,
  items,
  onDelete,
}: {
  title: string;
  items: WhisperModelEntry[];
  onDelete: (name: string) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-gray-500">
        {t("transcription.settings.cacheEmpty", { kind: title })}
      </p>
    );
  }
  return (
    <div className="mt-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{title}</div>
      <ul className="mt-1 divide-y divide-gray-800">
        {items.map((m) => (
          <li key={m.name} className="flex items-center justify-between gap-2 py-2 text-[11px]">
            <div className="min-w-0">
              <div className="truncate font-mono text-gray-200">{m.name}</div>
              <div className="text-gray-500">{humanSize(m.size_bytes)}</div>
            </div>
            <button
              type="button"
              onClick={() => onDelete(m.name)}
              className="rounded-lg bg-red-900/30 px-2 py-1 text-red-300 hover:bg-red-800/40"
            >
              {t("common.delete")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DownloadPickerModal({
  kind,
  catalog,
  cachedNames,
  onDownload,
  onClose,
}: {
  kind: "whisper" | "uvr";
  catalog: WhisperModelEntry[];
  cachedNames: Set<string>;
  onDownload: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-3xl border border-gray-800 bg-gray-950 p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-100">
            {t("transcription.settings.downloadTitle", { kind })}
          </h3>
          <button onClick={onClose} className="text-xs text-gray-400">
            {t("common.close")}
          </button>
        </div>
        <ul className="space-y-2">
          {catalog.length === 0 && (
            <li className="text-xs text-gray-500">{t("transcription.settings.catalogEmpty")}</li>
          )}
          {catalog.map((entry) => {
            const isCached = cachedNames.has(entry.name);
            return (
              <li
                key={entry.name}
                className="flex items-start justify-between gap-3 rounded-2xl bg-gray-900 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-gray-200">{entry.name}</span>
                    {entry.size_hint && (
                      <span className="text-[10px] text-gray-500">· {entry.size_hint}</span>
                    )}
                  </div>
                  {entry.description && (
                    <p className="mt-1 text-[11px] text-gray-500">{entry.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={isCached}
                  onClick={() => onDownload(entry.name)}
                  className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isCached ? t("transcription.settings.cached") : t("transcription.settings.download")}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
