import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { LlmConnection, LlmMode, LlmProvider } from "../../types";

const PROVIDERS: LlmProvider[] = ["local", "openai", "anthropic", "gemini"];
const DEFAULT_LOCAL_ENDPOINT = "http://localhost:8000/v1";

const MODE_HELP_KEY: Record<LlmMode, string> = {
  single: "settings.connections.modeHelpSingle",
  fallback: "settings.connections.modeHelpFallback",
  parallel: "settings.connections.modeHelpParallel",
};

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]";
const selectCls = inputCls;
const labelCls = "mb-1.5 block text-[12px] font-medium text-[var(--text-2)]";

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
      // leaking it via server logs, proxies, or Referer headers).
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: c.provider,
          ...(c.apiKey ? { key: c.apiKey } : {}),
          ...(c.provider === "local" && c.endpoint ? { endpoint: c.endpoint } : {}),
        }),
      });
      const data = await res.json();
      if (data.models?.length) setModelsByConn((m) => ({ ...m, [c.id]: data.models }));
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
        apiKey: c.apiKey,
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

      {/* Connection cards */}
      <div className="space-y-3">
        {conns.map((c, i) => {
          const models = modelsByConn[c.id] || [];
          const showKey = showKeyByConn[c.id];
          const result = testResultByConn[c.id];
          return (
            <div key={c.id} className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
              {/* Header row */}
              <div className="flex items-center gap-2">
                {mode === "single" && (
                  <input
                    type="radio"
                    name="active-connection"
                    checked={activeId === c.id}
                    onChange={() => update("active_connection_id", c.id)}
                    title={t("settings.connections.activeTitle")}
                    aria-label={c.label}
                    className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                )}
                <input
                  value={c.label}
                  onChange={(e) => updateConn(c.id, { label: e.target.value })}
                  placeholder={t("settings.connections.connectionName")}
                  className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] font-medium text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
                {mode !== "single" && (
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => updateConn(c.id, { enabled: e.target.checked })}
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    {t("settings.connections.enabled")}
                  </label>
                )}
                <button onClick={() => moveConn(c.id, -1)} disabled={i === 0} className="px-1.5 text-[13px] text-[var(--text-3)] disabled:opacity-30" title={t("settings.connections.moveUp")}>↑</button>
                <button onClick={() => moveConn(c.id, 1)} disabled={i === conns.length - 1} className="px-1.5 text-[13px] text-[var(--text-3)] disabled:opacity-30" title={t("settings.connections.moveDown")}>↓</button>
                <button onClick={() => removeConn(c.id)} className="px-1.5 text-[13px] text-[var(--red)]" title={t("settings.connections.remove")}>🗑</button>
              </div>

              {/* Provider */}
              <div className="flex overflow-hidden rounded-lg border border-[var(--border)]">
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    onClick={() => changeProvider(c.id, p)}
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

              <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
                {c.provider === "local" && (
                  <div>
                    <label className={labelCls}>{t("settings.connections.endpoint")}</label>
                    <input
                      value={c.endpoint}
                      onChange={(e) => updateConn(c.id, { endpoint: e.target.value })}
                      placeholder={DEFAULT_LOCAL_ENDPOINT}
                      className={inputCls}
                    />
                  </div>
                )}
                <div>
                  <label className={labelCls}>{c.provider === "local" ? t("settings.connections.apiKeyOptional") : t("settings.connections.apiKey")}</label>
                  <div className="flex gap-2">
                    <input
                      type={showKey ? "text" : "password"}
                      value={c.apiKey}
                      onChange={(e) => updateConn(c.id, { apiKey: e.target.value })}
                      placeholder={c.provider === "local" ? t("settings.connections.apiKeyPlaceholderLocal") : t("settings.connections.apiKeyPlaceholder")}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                    <button
                      onClick={() => setShowKeyByConn((s) => ({ ...s, [c.id]: !showKey }))}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-2)]"
                    >
                      {showKey ? "🙈" : "👁"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Model */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[12px] font-medium text-[var(--text-2)]">{t("settings.connections.model")}</label>
                  <button onClick={() => fetchModels(c)} className="text-[10.5px] text-[var(--accent)]">
                    {loadingByConn[c.id] ? t("common.loading") : t("settings.llmConnection.fetchModels")}
                  </button>
                </div>
                {models.length > 0 ? (
                  <select value={c.model} onChange={(e) => updateConn(c.id, { model: e.target.value })} className={selectCls}>
                    <option value="">{t("settings.llmConnection.selectModel")}</option>
                    {models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={c.model}
                    onChange={(e) => updateConn(c.id, { model: e.target.value })}
                    placeholder={t("settings.connections.modelPlaceholder")}
                    className={inputCls}
                  />
                )}
              </div>

              {/* Test */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => testConn(c)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:text-[var(--text)]"
                >
                  {testingByConn[c.id] ? t("settings.connections.testing") : t("settings.connections.test")}
                </button>
                {result && (
                  <span className={`text-[12px] ${result.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>
                    {result.ok ? result.message : result.message.includes("ECONNREFUSED") ? t("settings.connections.refused") : result.message}
                  </span>
                )}
              </div>
            </div>
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
