import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { LlmConnection, LlmMode, LlmProvider } from "../../types";
import { Field, RowActionsMenu } from "../../ui/primitives";
import { FORM_CONTROL_CLS, FORM_LABEL_CLS } from "../../ui/form-classes";

const PROVIDERS: LlmProvider[] = ["local", "openai", "anthropic", "gemini"];
const DEFAULT_LOCAL_ENDPOINT = "http://localhost:8000/v1";
const REDACTED_SECRET = "__SUBSMELT_SECRET_REDACTED__";

const MODE_HELP_KEY: Record<LlmMode, string> = {
  single: "settings.connections.modeHelpSingle",
  fallback: "settings.connections.modeHelpFallback",
  parallel: "settings.connections.modeHelpParallel",
};

const selectCls = FORM_CONTROL_CLS;
const labelCls = FORM_LABEL_CLS;

type ToastFn = (message: string, type: "success" | "error" | "info") => void;

interface ConnectionsPanelProps {
  settings: Record<string, unknown>;
  update: (key: string, value: unknown) => void;
  addToast: ToastFn;
  isMobile: boolean;
}

function genId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `conn-${Math.random().toString(36).slice(2, 10)}`;
}

function parseConnections(raw: unknown): LlmConnection[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr as LlmConnection[];
  } catch {
    /* ignore */
  }
  return [];
}

export function ConnectionsPanel({ settings, update, addToast, isMobile }: ConnectionsPanelProps) {
  const { t } = useTranslation();
  const modeLabelId = useId();
  const [modelsByConn, setModelsByConn] = useState<Record<string, string[]>>({});
  const [loadingByConn, setLoadingByConn] = useState<Record<string, boolean>>({});
  const [testingByConn, setTestingByConn] = useState<Record<string, boolean>>({});
  const [testResultByConn, setTestResultByConn] = useState<Record<string, { ok: boolean; message: string } | undefined>>({});
  const [showKeyByConn, setShowKeyByConn] = useState<Record<string, boolean>>({});
  // Per-card override of the default expansion. Absent = follow the default for
  // the current mode (see `defaultExpanded` below).
  const [expandedByConn, setExpandedByConn] = useState<Record<string, boolean>>({});

  const conns = parseConnections(settings.llm_connections);
  const mode = ((settings.llm_mode as LlmMode) || "single") as LlmMode;
  const activeId = (settings.active_connection_id as string) || conns[0]?.id || "";

  const writeConns = (next: LlmConnection[]) => update("llm_connections", JSON.stringify(next));

  const updateConn = (id: string, patch: Partial<LlmConnection>) =>
    writeConns(conns.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addConn = () => {
    const id = genId();
    const next: LlmConnection = {
      id,
      label: t("settings.connections.defaultLabel", { index: conns.length + 1 }),
      provider: "local",
      apiKey: "",
      model: "",
      endpoint: DEFAULT_LOCAL_ENDPOINT,
      enabled: true,
      order: conns.length,
    };
    writeConns([...conns, next]);
    // A brand-new connection has nothing configured yet — always open it.
    setExpandedByConn((s) => ({ ...s, [id]: true }));
  };

  const removeConn = (id: string) => {
    const next = conns.filter((c) => c.id !== id).map((c, i) => ({ ...c, order: i }));
    writeConns(next);
    if (activeId === id) update("active_connection_id", next[0]?.id || "");
  };

  const moveConn = (id: string, dir: -1 | 1) => {
    const idx = conns.findIndex((c) => c.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= conns.length) return;
    const next = [...conns];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    writeConns(next.map((c, i) => ({ ...c, order: i })));
  };

  const changeProvider = (id: string, provider: LlmProvider) => {
    const c = conns.find((x) => x.id === id);
    const patch: Partial<LlmConnection> = { provider };
    if (provider === "local" && !c?.endpoint) patch.endpoint = DEFAULT_LOCAL_ENDPOINT;
    updateConn(id, patch);
    setModelsByConn((m) => ({ ...m, [id]: [] }));
  };

  const fetchModels = async (c: LlmConnection) => {
    setLoadingByConn((s) => ({ ...s, [c.id]: true }));
    try {
      // POST so the API key travels in the body, not the query string (avoids
      // leaking it via server logs, proxies, or Referer headers). fetchJSON
      // centralizes error handling (throws ApiError on non-2xx with the server
      // error message) for consistency with the rest of the API layer.
      const data = await api.fetchJSON<{ models?: string[]; error?: string }>("/models", {
        method: "POST",
        body: JSON.stringify({
          provider: c.provider,
          ...(c.apiKey && c.apiKey !== REDACTED_SECRET ? { key: c.apiKey } : {}),
          ...(c.provider === "local" && c.endpoint ? { endpoint: c.endpoint } : {}),
        }),
      });
      if (data.models?.length) setModelsByConn((m) => ({ ...m, [c.id]: data.models as string[] }));
      else addToast(data.error || t("settings.llmConnection.noModelsFound"), "error");
    } catch (e: unknown) {
      addToast(e instanceof Error ? e.message : String(e), "error");
    }
    setLoadingByConn((s) => ({ ...s, [c.id]: false }));
  };

  const testConn = async (c: LlmConnection) => {
    setTestingByConn((s) => ({ ...s, [c.id]: true }));
    setTestResultByConn((s) => ({ ...s, [c.id]: undefined }));
    try {
      const result = await api.testConnection({
        provider: c.provider,
        ...(c.apiKey !== REDACTED_SECRET ? { apiKey: c.apiKey } : {}),
        model: c.model,
        endpoint: c.endpoint,
      });
      setTestResultByConn((s) => ({ ...s, [c.id]: result }));
      addToast(result.ok ? `✓ ${c.label}: ${result.message}` : `✗ ${c.label}: ${result.message}`, result.ok ? "success" : "error");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setTestResultByConn((s) => ({ ...s, [c.id]: { ok: false, message } }));
      addToast(message, "error");
    }
    setTestingByConn((s) => ({ ...s, [c.id]: false }));
  };

  return (
    <div className="space-y-4">
      {/* Mode selector */}
      <div>
        <label id={modeLabelId} className={labelCls}>{t("settings.connections.mode")}</label>
        <div role="group" aria-labelledby={modeLabelId} className="flex overflow-hidden rounded-lg border border-[var(--border)]">
          {(["single", "fallback", "parallel"] as LlmMode[]).map((m) => (
            <button
              key={m}
              onClick={() => update("llm_mode", m)}
              aria-pressed={mode === m}
              className={`flex-1 border-r border-[var(--border)] py-[7px] text-[12px] font-medium transition-colors last:border-r-0 ${
                mode === m
                  ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "bg-[var(--surface-2)] text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
              }`}
            >
              {t(`settings.connections.mode${m.charAt(0).toUpperCase()}${m.slice(1)}`)}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-3)]">{t(MODE_HELP_KEY[mode])}</p>
      </div>

      {/* Connection cards. In `single` mode only the active connection is
          expanded — the others collapse to a one-line summary, since their
          endpoint/key/model have no effect until they are made active. In
          fallback/parallel mode every connection is live, so all cards open. */}
      <div className="space-y-3">
        {conns.map((c, i) => {
          const isActive = activeId === c.id;
          const defaultExpanded = mode !== "single" || isActive;
          return (
            <ConnectionCard
              key={c.id}
              conn={c}
              index={i}
              total={conns.length}
              mode={mode}
              isActive={isActive}
              isMobile={isMobile}
              expanded={expandedByConn[c.id] ?? defaultExpanded}
              onToggleExpanded={() => setExpandedByConn((s) => ({ ...s, [c.id]: !(s[c.id] ?? defaultExpanded) }))}
              models={modelsByConn[c.id] || []}
              loadingModels={Boolean(loadingByConn[c.id])}
              testing={Boolean(testingByConn[c.id])}
              testResult={testResultByConn[c.id]}
              showKey={Boolean(showKeyByConn[c.id])}
              onToggleShowKey={() => setShowKeyByConn((s) => ({ ...s, [c.id]: !s[c.id] }))}
              onSetActive={() => update("active_connection_id", c.id)}
              onPatch={(patch) => updateConn(c.id, patch)}
              onChangeProvider={(p) => changeProvider(c.id, p)}
              onMove={(dir) => moveConn(c.id, dir)}
              onRemove={() => removeConn(c.id)}
              onFetchModels={() => fetchModels(c)}
              onTest={() => testConn(c)}
            />
          );
        })}
      </div>

      <button
        onClick={addConn}
        className="w-full rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] py-2.5 text-[13px] font-medium text-[var(--accent)] hover:bg-[var(--surface-3)]"
      >
        {t("settings.connections.add")}
      </button>
    </div>
  );
}

interface ConnectionCardProps {
  conn: LlmConnection;
  index: number;
  total: number;
  mode: LlmMode;
  isActive: boolean;
  isMobile: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  models: string[];
  loadingModels: boolean;
  testing: boolean;
  testResult: { ok: boolean; message: string } | undefined;
  showKey: boolean;
  onToggleShowKey: () => void;
  onSetActive: () => void;
  onPatch: (patch: Partial<LlmConnection>) => void;
  onChangeProvider: (provider: LlmProvider) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onFetchModels: () => void;
  onTest: () => void;
}

/**
 * A single LLM connection.
 *
 * Split out of the `conns.map()` callback so each card can own hook state
 * (`useId` for the provider group and the model select) — the inline version
 * hand-rolled its inputs and lost label/`aria-describedby` linkage entirely.
 * The text inputs are now the shared `Field` primitive.
 */
function ConnectionCard({
  conn: c,
  index,
  total,
  mode,
  isActive,
  isMobile,
  expanded,
  onToggleExpanded,
  models,
  loadingModels,
  testing,
  testResult,
  showKey,
  onToggleShowKey,
  onSetActive,
  onPatch,
  onChangeProvider,
  onMove,
  onRemove,
  onFetchModels,
  onTest,
}: ConnectionCardProps) {
  const { t } = useTranslation();
  const bodyId = useId();
  const providerGroupId = useId();
  const modelSelectId = useId();

  const providerLabel = t(`settings.llmConnection.provider_${c.provider}`);
  const summary = `${providerLabel} · ${c.model || t("settings.connections.noModel")}`;

  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
      {/* Header row: active/enabled control, the disclosure summary, row actions */}
      <div className="flex items-center gap-2">
        {mode === "single" && (
          <input
            type="radio"
            name="active-connection"
            checked={isActive}
            onChange={onSetActive}
            title={t("settings.connections.activeTitle")}
            aria-label={t("settings.connections.activeAria", { label: c.label })}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
        )}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left hover:bg-[var(--surface-3)]"
        >
          <span className={`shrink-0 text-[var(--text-3)] transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} aria-hidden="true">▾</span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-[var(--text)]">{c.label || t("settings.connections.connectionName")}</span>
            {!expanded && <span className="block truncate text-[11px] text-[var(--text-3)]">{summary}</span>}
          </span>
        </button>
        {mode !== "single" && (
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--text-2)]">
            <input
              type="checkbox"
              checked={c.enabled}
              onChange={(e) => onPatch({ enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            {t("settings.connections.enabled")}
          </label>
        )}
        <RowActionsMenu
          items={[
            { label: t("settings.connections.moveUp"), onClick: () => onMove(-1), disabled: index === 0 },
            { label: t("settings.connections.moveDown"), onClick: () => onMove(1), disabled: index === total - 1 },
            { label: t("settings.connections.remove"), onClick: onRemove, danger: true },
          ]}
        />
      </div>

      {expanded && (
        <div id={bodyId} className="space-y-3">
          <Field
            label={t("settings.connections.connectionName")}
            value={c.label}
            onChange={(v) => onPatch({ label: v })}
            placeholder={t("settings.connections.connectionName")}
          />

          {/* Provider */}
          <div>
            <span id={providerGroupId} className={labelCls}>{t("settings.connections.provider")}</span>
            <div role="group" aria-labelledby={providerGroupId} className="flex overflow-hidden rounded-lg border border-[var(--border)]">
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  onClick={() => onChangeProvider(p)}
                  aria-pressed={c.provider === p}
                  className={`flex-1 border-r border-[var(--border)] py-1.5 text-[11.5px] font-medium transition-colors last:border-r-0 ${
                    c.provider === p
                      ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                      : "bg-[var(--surface)] text-[var(--text-2)] hover:text-[var(--text)]"
                  }`}
                >
                  {t(`settings.llmConnection.provider_${p}`)}
                </button>
              ))}
            </div>
          </div>

          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
            {c.provider === "local" && (
              <Field
                label={t("settings.connections.endpoint")}
                value={c.endpoint}
                onChange={(v) => onPatch({ endpoint: v })}
                placeholder={DEFAULT_LOCAL_ENDPOINT}
              />
            )}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field
                  label={c.provider === "local" ? t("settings.connections.apiKeyOptional") : t("settings.connections.apiKey")}
                  value={c.apiKey === REDACTED_SECRET ? "" : c.apiKey}
                  onChange={(v) => onPatch({ apiKey: v })}
                  type={showKey ? "text" : "password"}
                  placeholder={c.apiKey === REDACTED_SECRET ? "••••••••" : c.provider === "local" ? t("settings.connections.apiKeyPlaceholderLocal") : t("settings.connections.apiKeyPlaceholder")}
                />
              </div>
              <button
                type="button"
                onClick={onToggleShowKey}
                aria-pressed={showKey}
                aria-label={showKey ? t("settings.connections.hideApiKey") : t("settings.connections.showApiKey")}
                className="flex min-h-[44px] shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-2)] hover:text-[var(--text)]"
              >
                <span aria-hidden="true">{showKey ? "🙈" : "👁"}</span>
              </button>
            </div>
          </div>

          {/* Model */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor={modelSelectId} className="text-[12px] font-medium text-[var(--text-2)]">{t("settings.connections.model")}</label>
              <button onClick={onFetchModels} className="text-[10.5px] text-[var(--accent)]">
                {loadingModels ? t("common.loading") : t("settings.llmConnection.fetchModels")}
              </button>
            </div>
            {models.length > 0 ? (
              <select id={modelSelectId} value={c.model} onChange={(e) => onPatch({ model: e.target.value })} className={selectCls}>
                <option value="">{t("settings.llmConnection.selectModel")}</option>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                id={modelSelectId}
                value={c.model}
                onChange={(e) => onPatch({ model: e.target.value })}
                placeholder={t("settings.connections.modelPlaceholder")}
                className={selectCls}
              />
            )}
          </div>

          {/* Test */}
          <div className="flex items-center gap-3">
            <button
              onClick={onTest}
              className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:text-[var(--text)]"
            >
              {testing ? t("settings.connections.testing") : t("settings.connections.test")}
            </button>
            {testResult && (
              <span className={`text-[12px] ${testResult.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>
                <span aria-hidden="true">{testResult.ok ? "✓ " : "✗ "}</span>
                {testResult.ok ? testResult.message : testResult.message.includes("ECONNREFUSED") ? t("settings.connections.refused") : testResult.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
