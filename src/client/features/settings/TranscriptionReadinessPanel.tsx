import type { UseQueryResult } from "@tanstack/react-query";
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

function formatMb(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "unknown";
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(value)} MB`;
}

function list(values?: string[]): string {
  return values?.length ? values.join(", ") : "unknown";
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
    ? "Speech-to-text is disabled. Subsmelt will continue translating existing subtitles without a Whisper backend."
    : !configured
      ? "Add a backend URL to enable local transcription readiness checks. Whisper is optional and not required by the main app."
      : healthQuery.isLoading
        ? "Checking the saved transcription backend…"
        : health?.ok
          ? "Ready to transcribe with the configured optional backend."
          : "Backend is configured but not reachable yet. Check that the optional whisper service is running and the URL is saved.";

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-950/45 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-200">Transcription readiness</div>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">{summary}</p>
          {dirty && configured && (
            <p className="mt-1 text-[10px] text-yellow-300">Save settings before refreshing readiness so the backend health check uses the latest URL/options.</p>
          )}
        </div>
        <ActionButton variant="ghost" onClick={() => healthQuery.refetch()} disabled={!configured || healthQuery.isFetching}>
          {healthQuery.isFetching ? "Refreshing…" : "Refresh readiness"}
        </ActionButton>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusBadge label="Feature" state={enabled ? "ok" : "info"} detail={enabled ? "Enabled" : "Disabled"} />
        <StatusBadge label="Backend URL" state={configured ? "ok" : "warn"} detail={configured ? backendUrl : "Not configured"} />
        <StatusBadge
          label="Backend reachability"
          state={!configured ? "info" : health?.endpointReachable ? "ok" : "fail"}
          detail={!configured ? "Skipped" : health?.endpointReachable ? "Reachable" : health?.reason === "endpoint-missing" ? "Missing URL" : "Not reachable"}
        />
        <StatusBadge
          label="ffmpeg"
          state={!health?.endpointReachable ? "info" : backendHealth?.ffmpeg ? "ok" : "fail"}
          detail={!health?.endpointReachable ? "Unknown" : backendHealth?.ffmpeg ? "Available" : "Missing"}
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-3">
          <div className="text-xs font-semibold text-gray-300">CPU RAM fit</div>
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <div>Available / total: <span className="text-gray-200">{formatMb(availableRamMb)} / {formatMb(backendHealth?.totalRamMb)}</span></div>
            <div>Selected model: <span className="text-gray-200">{selectedModel}</span></div>
            <div>Recommended for CPU: <span className="text-gray-200">{formatMb(requirements.recommended)}</span> (minimum {formatMb(requirements.required)})</div>
            {ramMeetsRecommended === true && <div className="text-green-300">RAM meets the CPU recommendation for this model.</div>}
            {ramMeetsRequired === true && ramMeetsRecommended === false && <div className="text-yellow-300">RAM meets the minimum but is below the recommendation; expect slower or less reliable runs.</div>}
            {ramMeetsRequired === false && <div className="text-red-300">RAM is below the minimum for {selectedModel}.{suggestedModel ? ` Consider ${suggestedModel}.` : " Consider a smaller model or skip transcription."}</div>}
            {!ramKnown && <div className="text-gray-500">RAM details will appear when the backend reports health.</div>}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-3">
          <div className="text-xs font-semibold text-gray-300">Backend capabilities</div>
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <div>Models: <span className="text-gray-200">{list(models)}</span></div>
            <div>Output formats: <span className="text-gray-200">{list(outputFormats)}</span></div>
            <div>Devices: <span className="text-gray-200">{list(capabilities?.devices)}</span></div>
            <div>Compute types: <span className="text-gray-200">{list(capabilities?.computeTypes)}</span></div>
            <div>VAD: <span className="text-gray-200">{capabilities?.vad === undefined ? "unknown" : capabilities.vad ? "supported" : "not advertised"}</span></div>
            {selectedModelAdvertised === false && <div className="text-yellow-300">Selected model is not advertised by this backend.</div>}
            {selectedOutputAdvertised === false && <div className="text-yellow-300">Selected output format is not advertised by this backend.</div>}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-gray-800 bg-gray-900/50 p-3">
        <div className="text-xs font-semibold text-gray-300">Model cache</div>
        <div className="mt-2 space-y-1 text-xs text-gray-400">
          <div>Selected model: <span className="text-gray-200">{cacheInfo?.model || selectedModel}</span></div>
          <div>Configured cache root: <span className="text-gray-200 break-all">{cacheInfo?.cacheRoot || "unknown"}</span></div>
          <div>Detected cache path: <span className="text-gray-200 break-all">{cacheInfo?.cachePath || "not found"}</span></div>
          <div>Status: <span className="text-gray-200">
            {cacheInfo?.cached === true ? "cached" : cacheInfo?.cached === false ? "not cached yet" : "unknown"}
          </span></div>
          {cacheInfo?.warning && <div className={cacheInfo.cached ? "text-blue-300" : "text-yellow-300"}>{cacheInfo.warning}</div>}
          {cacheInfo?.firstRunDownloadExpected && <div className="text-yellow-300">First run may spend extra time downloading model weights before transcription starts.</div>}
          {!cacheInfo && <div className="text-gray-500">Cache details will appear when the backend reports health for the selected model.</div>}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-gray-800 bg-gray-950/60 p-3 text-xs text-gray-400">
        Current request defaults: <span className="text-gray-200">{selectedModel}</span> on <span className="text-gray-200">{selectedDevice}</span> / <span className="text-gray-200">{selectedComputeType}</span>, output <span className="text-gray-200">{selectedOutput.toUpperCase()}</span>.
        {health?.message && <span className="ml-1 text-yellow-300">Backend message: {health.message}</span>}
      </div>
    </div>
  );
}
