import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

type ToastType = "success" | "error" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  persistent?: boolean;
  /** A toast with the same key is updated in place instead of stacking. */
  key?: string;
  action?: ToastAction;
  onDismiss?: () => void;
}

interface Toast extends ToastOptions {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  addToast: (message: string, type?: ToastType, opts?: ToastOptions) => void;
  removeToast: (id: number) => void;
}

// Older toasts stay queued behind these and surface as newer ones go away, so
// a burst of failures never pushes the stack off the screen.
const MAX_VISIBLE_TOASTS = 4;

const AUTO_DISMISS_MS: Record<ToastType, number> = { error: 5000, success: 2500, info: 3500 };

const ToastContext = createContext<ToastContextType>({
  addToast: () => {},
  removeToast: () => {},
});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Mirror of `toasts` for lookups inside addToast without re-creating it.
  const toastsRef = useRef<Toast[]>([]);
  toastsRef.current = toasts;

  const clearTimer = (id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
  };

  const removeToast = useCallback((id: number) => {
    clearTimer(id);
    setToasts((prev) => {
      prev.find((toast) => toast.id === id)?.onDismiss?.();
      return prev.filter((toast) => toast.id !== id);
    });
  }, []);

  const removeAll = () => {
    toastsRef.current.forEach((toast) => removeToast(toast.id));
  };

  const addToast = useCallback(
    (message: string, type: ToastType = "info", opts: ToastOptions = {}) => {
      const existing = opts.key ? toastsRef.current.find((toast) => toast.key === opts.key) : undefined;
      const id = existing?.id ?? ++idRef.current;
      const next: Toast = { ...opts, id, message, type };
      setToasts((prev) => (existing ? prev.map((toast) => (toast.id === id ? next : toast)) : [...prev, next]));
      clearTimer(id);
      if (!opts.persistent) {
        timersRef.current.set(id, setTimeout(() => removeToast(id), AUTO_DISMISS_MS[type]));
      }
    },
    [removeToast]
  );

  // Clear any pending auto-dismiss timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach((timer) => clearTimeout(timer)); timers.clear(); };
  }, []);

  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* Toast container — aria-live so screen readers announce notifications. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed inset-x-4 bottom-20 z-[100] flex flex-col gap-2 md:inset-x-auto md:bottom-4 md:right-4 md:max-w-sm"
      >
        {toasts.length > 1 && (
          <button
            type="button"
            onClick={removeAll}
            className="min-h-[44px] self-end rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[12px] font-medium text-[var(--text-2)] shadow-lg hover:text-[var(--text)]"
          >
            {t("common.dismissAll")}
          </button>
        )}
        {visible.map((toast) => (
          <div
            key={toast.id}
            role={toast.type === "error" ? "alert" : "status"}
            // Toasts float over arbitrary content, so the tint tokens (~10-13%
            // alpha) are too sheer to read against. Use the opaque surface for
            // the fill and carry the semantic colour on the border, icon and text.
            className={`flex items-start gap-2 rounded-2xl border bg-[var(--surface)] px-4 py-3 shadow-lg text-sm animate-[slideIn_0.2s_ease-out] ${
              toast.type === "success"
                ? "border-[var(--green-border)] text-[var(--green)]"
                : toast.type === "error"
                ? "border-[var(--red-border)] text-[var(--red)]"
                : "border-[var(--accent-border)] text-[var(--accent)]"
            }`}
          >
            <span className="shrink-0 mt-0.5">
              {toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}
            </span>
            <span className="min-w-0 flex-1 break-words">
              {toast.message}
              {toast.action && (
                <button
                  type="button"
                  onClick={() => { toast.action?.onClick(); removeToast(toast.id); }}
                  className="mt-1 block min-h-[44px] text-[13px] font-medium text-[var(--text)] underline underline-offset-2"
                >
                  {toast.action.label}
                </button>
              )}
            </span>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="-m-2 flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center opacity-60 hover:opacity-100"
              aria-label={t("common.dismiss")}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
