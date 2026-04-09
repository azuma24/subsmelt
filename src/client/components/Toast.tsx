import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
  persistent?: boolean;
}

interface ToastContextType {
  addToast: (message: string, type?: "success" | "error" | "info", persistent?: boolean) => void;
  removeToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextType>({
  addToast: () => {},
  removeToast: () => {},
});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: "success" | "error" | "info" = "info", persistent = false) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, message, type, persistent }]);
      if (!persistent) {
        const duration = type === "error" ? 5000 : type === "success" ? 2500 : 3500;
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* Toast container */}
      <div className="fixed inset-x-4 bottom-20 z-[100] flex flex-col gap-2 md:inset-x-auto md:bottom-4 md:right-4 md:max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-start gap-2 rounded-2xl px-4 py-3 shadow-lg text-sm animate-[slideIn_0.2s_ease-out] ${
              toast.type === "success"
                ? "bg-green-900/90 text-green-200 border border-green-800"
                : toast.type === "error"
                ? "bg-red-900/90 text-red-200 border border-red-800"
                : "bg-blue-900/90 text-blue-200 border border-blue-800"
            }`}
          >
            <span className="shrink-0 mt-0.5">
              {toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}
            </span>
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="shrink-0 opacity-60 hover:opacity-100 ml-2"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
