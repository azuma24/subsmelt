import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AppErrorBoundary } from "./ui/AppErrorBoundary";
import "./index.css";
import i18n, { I18nProvider } from "./i18n";

const queryClient = new QueryClient({
  // Don't auto-retry mutations — a failed POST/DELETE retried 3× can double-fire
  // state-changing actions (queue start, deletes) against a same-host backend.
  defaultOptions: { mutations: { retry: 0 } },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </I18nProvider>
  </React.StrictMode>,
);
