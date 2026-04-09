import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({ opts, resolve });
    });
  }, []);

  const handleClose = (result: boolean) => {
    state?.resolve(result);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {state && (
        <div className="fixed inset-0 bg-black/60 flex items-end justify-center z-[90] p-0 md:items-center md:p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-t-3xl md:rounded-3xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-base font-semibold text-gray-100">{state.opts.title}</h3>
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
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
