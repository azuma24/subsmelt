import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TranscriptionHealth } from "../../types";
import { ActionButton } from "../../ui/primitives";

const MODEL_RAM_MB: Record<string, { required: number; recommended: number }> = {
  tiny: { required: 2048, recommended: 4096 },
  base: { required: 3072, recommended: 4096 },
  small: { required: 4096, recommended: 8192 },
  medium: { required: 8192, recommended: 16384 },
  large: { required: 16384, recommended: 32768 },
  "large-v2": { required: 16384, recommended: 32768 },
  "large-v3": { required: 16384, recommended: 32768 },
  "large-v3-turbo": { required: 12288, recommended: 24576 },
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function formatMb(value?: number, unknownLabel = "unknown"): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return unknownLabel;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(value)} MB`;
}

function list(values: string[] | undefined, unknownLabel: string): string {
  return values?.length ? values.join(", ") : unknownLabel;
}

function modelRequirements(model: string) {
  return MODEL_RAM_MB[model.toLowerCase()] ?? MODEL_RAM_MB.small;
}

function suggestCpuModel(availableRamMb?: number): string | null {
  if (typeof availableRamMb !== "number" || availableRamMb <= 0) return null;
  for (const model of ["small", "base", "tiny"]) {
    if (availableRamMb >= MODEL_RAM_MB[model].required) return model;
  }
  return null;
}

function StatusBadge({ label, state, detail }: { label: string; state: "ok" | "warn" | "fail" | "info"; detail: string }) {
  const classes = {
    ok: "border-green-800/50 bg-green-900/25 text-green-200",
    warn: "border-yellow-800/50 bg-yellow-900/25 text-yellow-200",
    fail: "border-red-800/50 bg-red-900/25 text-red-200",
    info: "border-blue-800/50 bg-blue-900/25 text-blue-200",
  }[state];

  return (
    <div className={`rounded-2xl border px-3 py-2 ${classes}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-0.5 text-sm font-medium">{detail}</div>
    </div>
  );
}

export function TranscriptionReadinessPanel({
  settings,
  healthQuery,
  dirty,
}: {
  settings: Record<string, unknown>;
  healthQuery: UseQueryResult<TranscriptionHealth>;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const unknownLabel = t("settings.transcription.readiness.unknown");
  const enabled = str(settings.transcription_enabled, "0") === "1";
  const backendUrl = str(settings.transcription_backend_url);
  const configured = Boolean(backendUrl);
  const selectedModel = str(settings.transcription_model, "small");
  const selectedOutput = str(settings.transcription_output_format, "srt");
  const selectedDevice = str(settings.transcription_device, "cpu");
  const selectedComputeType = str(settings.transcription_compute_type, "int8");
  const health = healthQuery.data;
  const backendHealth = health?.health;
  const capabilities = backendHealth?.capabilities;
  const cacheInfo = backendHealth?.modelCache;
  const requirements = {
    required: cacheInfo?.requiredRamMb ?? modelRequirements(selectedModel).required,
    recommended: cacheInfo?.recommendedRamMb ?? modelRequirements(selectedModel).recommended,
  };
  const availableRamMb = backendHealth?.availableRamMb;
  const ramKnown = typeof availableRamMb === "number" && availableRamMb > 0;
  const ramMeetsRequired = ramKnown ? availableRamMb >= requirements.required : undefined;
  const ramMeetsRecommended = ramKnown ? availableRamMb >= requirements.recommended : undefined;
  const suggestedModel = cacheInfo?.suggestedModel ?? (ramMeetsRequired === false ? suggestCpuModel(availableRamMb) : null);
  const models = capabilities?.models;
  const outputFormats = capabilities?.outputFormats;
  const selectedModelAdvertised = models?.length ? models.includes(selectedModel) : undefined;
  const selectedOutputAdvertised = outputFormats?.length ? outputFormats.includes(selectedOutput) : undefined;

  const summary = !enabled
    ? t("settings.transcription.readiness.disabledSummary")
    : !configured
      ? t("settings.transcription.readiness.needsBackendSummary")
      : healthQuery.isLoading
        ? t("settings.transcription.readiness.checkingSummary")
        : health?.ok
          ? t("settings.transcription.readiness.readySummary")
          : t("settings.transcription.readiness.unreachableSummary");

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-950/45 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-200">{t("settings.transcription.readiness.title")}</div>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">{summary}</p>
          {dirty && configured && (
            <p className="mt-1 text-[10px] text-yellow-300">{t("settings.transcription.readiness.saveBeforeRefresh")}</p>
          )}
        </div>
        <ActionButton variant="ghost" onClick={() => healthQuery.refetch()} disabled={!configured || healthQuery.isFetching}>
          {healthQuery.isFetching ? t("settings.transcription.readiness.refreshing") : t("settings.transcription.readiness.refresh")}
        </ActionButton>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusBadge label={t("settings.transcription.readiness.feature")} state={enabled ? "ok" : "info"} detail={enabled ? t("settings.transcription.readiness.enabled") : t("settings.transcription.readiness.disabled")} />
        <StatusBadge label={t("settings.transcription.readiness.backendUrl")} state={configured ? "ok" : "warn"} detail={configured ? backendUrl : t("settings.transcription.readiness.notConfigured")} />
        <StatusBadge
          label={t("settings.transcription.readiness.backendReachability")}
          state={!configured ? "info" : health?.endpointReachable ? "ok" : "fail"}
          detail={!configured ? t("settings.transcription.readiness.skipped") : health?.endpointReachable ? t("settings.transcription.readiness.reachable") : health?.reason === "endpoint-missing" ? t("settings.transcription.readiness.missingUrl") : t("settings.transcription.readiness.notReachable")}
        />
        <StatusBadge
          label={t("settings.transcription.readiness.ffmpeg")}
          state={!health?.endpointReachable ? "info" : backendHealth?.ffmpeg ? "ok" : "fail"}
          detail={!health?.endpointReachable ? unknownLabel : backendHealth?.ffmpeg ? t("settings.transcription.readiness.available") : t("settings.transcription.readiness.missing")}
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-3">
          <div className="text-xs font-semibold text-gray-300">{t("settings.transcription.readiness.cpuRamFit")}</div>
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <div>{t("settings.transcription.readiness.availableTotal")}: <span className="text-gray-200">{formatMb(availableRamMb, unknownLabel)} / {formatMb(backendHealth?.totalRamMb, unknownLabel)}</span></div>
            <div>{t("settings.transcription.readiness.selectedModel")}: <span className="text-gray-200">{selectedModel}</span></div>
            <div>{t("settings.transcription.readiness.recommendedCpu")}: <span className="text-gray-200">{formatMb(requirements.recommended, unknownLabel)}</span> ({t("settings.transcription.readiness.minimum")} {formatMb(requirements.required, unknownLabel)})</div>
            {ramMeetsRecommended === true && <div className="text-green-300">{t("settings.transcription.readiness.ramRecommended")}</div>}
            {ramMeetsRequired === true && ramMeetsRecommended === false && <div className="text-yellow-300">{t("settings.transcription.readiness.ramMinimumOnly")}</div>}
            {ramMeetsRequired === false && <div className="text-red-300">{t("settings.transcription.readiness.ramBelowMinimum", { model: selectedModel, suggestedModel })}</div>}
            {!ramKnown && <div className="text-gray-500">{t("settings.transcription.readiness.ramDetailsPending")}</div>}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-3">
          <div className="text-xs font-semibold text-gray-300">{t("settings.transcription.readiness.backendCapabilities")}</div>
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <div>{t("settings.transcription.readiness.models")}: <span className="text-gray-200">{list(models, unknownLabel)}</span></div>
            <div>{t("settings.transcription.readiness.outputFormats")}: <span className="text-gray-200">{list(outputFormats, unknownLabel)}</span></div>
            <div>{t("settings.transcription.readiness.devices")}: <span className="text-gray-200">{list(capabilities?.devices, unknownLabel)}</span></div>
            <div>{t("settings.transcription.readiness.computeTypes")}: <span className="text-gray-200">{list(capabilities?.computeTypes, unknownLabel)}</span></div>
            <div>{t("settings.transcription.readiness.vad")}: <span className="text-gray-200">{capabilities?.vad === undefined ? unknownLabel : capabilities.vad ? t("settings.transcription.readiness.supported") : t("settings.transcription.readiness.notAdvertised")}</span></div>
            {selectedModelAdvertised === false && <div className="text-yellow-300">{t("settings.transcription.readiness.modelNotAdvertised")}</div>}
            {selectedOutputAdvertised === false && <div className="text-yellow-300">{t("settings.transcription.readiness.outputNotAdvertised")}</div>}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-gray-800 bg-gray-900/50 p-3">
        <div className="text-xs font-semibold text-gray-300">{t("settings.transcription.readiness.modelCache")}</div>
        <div className="mt-2 space-y-1 text-xs text-gray-400">
          <div>{t("settings.transcription.readiness.selectedModel")}: <span className="text-gray-200">{cacheInfo?.model || selectedModel}</span></div>
          <div>{t("settings.transcription.readiness.cacheRoot")}: <span className="text-gray-200 break-all">{cacheInfo?.cacheRoot || unknownLabel}</span></div>
          <div>{t("settings.transcription.readiness.cachePath")}: <span className="text-gray-200 break-all">{cacheInfo?.cachePath || t("settings.transcription.readiness.notFound")}</span></div>
          <div>{t("settings.transcription.readiness.status")}: <span className="text-gray-200">
            {cacheInfo?.cached === true ? t("settings.transcription.readiness.cached") : cacheInfo?.cached === false ? t("settings.transcription.readiness.notCachedYet") : unknownLabel}
          </span></div>
          {cacheInfo?.warning && <div className={cacheInfo.cached ? "text-blue-300" : "text-yellow-300"}>{cacheInfo.warning}</div>}
          {cacheInfo?.firstRunDownloadExpected && <div className="text-yellow-300">{t("settings.transcription.readiness.firstRunDownload")}</div>}
          {!cacheInfo && <div className="text-gray-500">{t("settings.transcription.readiness.cachePending")}</div>}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-gray-800 bg-gray-950/60 p-3 text-xs text-gray-400">
        {t("settings.transcription.readiness.currentDefaults", { model: selectedModel, device: selectedDevice, computeType: selectedComputeType, output: selectedOutput.toUpperCase() })}
        {health?.message && <span className="ml-1 text-yellow-300">{t("settings.transcription.readiness.backendMessage", { message: health.message })}</span>}
        <div className="mt-2 text-yellow-200">{t("settings.transcription.readiness.firstRunQuiet")}</div>
      </div>
    </div>
  );
}
