import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./ModalShell";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmContextType {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType>({
  confirm: () => Promise.resolve(false),
});

export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);

  // Always points at the latest pending resolver so button handlers don't close
  // over a stale render-time value when state is replaced mid-tick.
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState((prev) => {
        // If a dialog is already pending, resolve it as false (superseded) before
        // replacing it with the new request so the first caller never hangs.
        prev?.resolve(false);
        return { opts, resolve };
      });
      // Update the ref synchronously so handleClose always reaches the correct
      // resolver even if the button is clicked before the next render commits.
      resolverRef.current = resolve;
    });
  }, []);

  const handleClose = (result: boolean) => {
    // Resolve via ref to guarantee we hit the latest pending promise, then clear
    // so a stale close can't accidentally resolve a subsequent dialog.
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {state && (
        <ModalShell
          title={state.opts.title}
          onClose={() => handleClose(false)}
          overlayClassName="fixed inset-0 bg-black/60 flex items-end justify-center z-[90] p-0 md:items-center md:p-4"
          panelClassName="bg-gray-900 border border-gray-700 rounded-t-3xl md:rounded-3xl p-6 w-full max-w-sm space-y-4"
        >
          <p className="text-sm text-gray-400">{state.opts.message}</p>
          <div className="flex gap-3 justify-end pt-2 sticky bottom-0 bg-gray-900">
            <button
              onClick={() => handleClose(false)}
              className="px-4 py-3 text-sm text-gray-400 hover:text-gray-200 rounded-2xl"
            >
              {state.opts.cancelLabel || t("common.cancel")}
            </button>
            <button
              onClick={() => handleClose(true)}
              className={`px-4 py-3 text-sm font-medium rounded-2xl ${
                state.opts.danger
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
              }`}
            >
              {state.opts.confirmLabel || t("common.confirm")}
            </button>
          </div>
        </ModalShell>
      )}
    </ConfirmContext.Provider>
  );
}
